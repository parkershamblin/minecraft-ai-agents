"""Phase 2 RB-race model sweep — N runs per model under the frozen config
(bench/race/frozen-config.json, docs/benchmark-rb.md).

Blocked by model: one world restore + one agent-service recreate per block
(both the world and the model env are read at boot), the model stays
GPU-resident for its whole block. Per block, before any run:

  0. Restore the pristine pinned-seed world (v3 protocol,
     docs/runbooks/race-world-reset.md) and verify the seed via RCON. Without
     it, wear accumulates across blocks and correlates with run index — the
     confound that blocks every between-model ranking claim in v1/v2.

Per run:

  1. `node scripts/race-rb2.mjs --label bench-<model>-r<i> --difficulty easy`
     (the harness executes + verifies the whole preflight checklist and ends
     itself — win or stall watchdog).
  2. Metrics extracted straight off the live ledger (bench_race.fetch_attempt),
     raw attempt + villager-window slices dumped for offline re-extraction.
  3. Honesty gate: AttemptEnded.honestRace deltas must be {0,0}. A dirty run
     is DISCARDED and rerun (never averaged in). A stalled-but-honest run is a
     kept DNF — a real signal about the model, it feeds the win-rate column.

The manifest (bench/results/sweep/manifest.json) is rewritten after every run:
the sweep is resume-safe — rerunning skips (model, index) pairs that already
have a kept record.

Run:
  uv run --with httpx python bench/sweep_race.py \
      --models llama3.1:8b,gemma3:12b --runs 5 \
      --world-snapshot D:/backups/ai-civilization-engine/pristine-6233701440491701965-v3.tgz
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

import bench_race

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parent
FROZEN_PATH = BENCH_DIR / "race" / "frozen-config.json"
SWEEP_DIR = BENCH_DIR / "results" / "sweep"
MANIFEST_PATH = SWEEP_DIR / "manifest.json"

AGENT_CONTAINER = "ai-civilization-engine-agent-service-1"
MEMORY_CONTAINER = "ai-civilization-engine-memory-service-1"
MINECRAFT_CONTAINER = "ai-civilization-engine-minecraft-1"
WORLD_VOLUME = "ai-civilization-engine_minecraft-data"
AGENT_HEALTH = "http://localhost:8001/healthz"
MEMORY_HEALTH = "http://localhost:8002/healthz"
OLLAMA = "http://localhost:11434"

COMPOSE_BASE = [
    "docker", "compose",
    "-f", str(REPO_ROOT / "infrastructure" / "docker" / "docker-compose.yml"),
    "--env-file", str(REPO_ROOT / ".env"),
]
COMPOSE = [*COMPOSE_BASE, "--profile", "infra", "--profile", "app"]
# The Paper service has no depends_on, so it starts standalone under its own
# profile (CLAUDE.md) — every other service still needs infra+app together.
COMPOSE_MC = [*COMPOSE_BASE, "--profile", "minecraft"]

# One rerun for a dirty (polluted) run, one for a preflight failure — a second
# consecutive preflight failure means the environment is broken and burning
# more GPU-hours unattended would be noise, so the sweep aborts loudly.
MAX_DIRTY_RERUNS = 2
RACE_TIMEOUT_SECONDS = 110 * 60  # 75m stall watchdog + preflight + margin
STALL_WATCHDOG_SECONDS = 75 * 60  # race-rb2.mjs inter-milestone watchdog
BASELINE_TICK = 30                # frozen TICK_INTERVAL_SECONDS
LEDGER_SETTLE_SECONDS = 10  # let the ledger consumer land the tail events


class SeedGateError(RuntimeError):
    """The restored world is not the pinned world.

    Deliberately its own type: block-setup failures are swallowed so an
    unattended sweep outlives one bad block, but a wrong world is not a bad
    block — every number produced after it would be measured on different
    terrain. This one escapes the handler and stops the sweep."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


def slug(model: str) -> str:
    return re.sub(r"[^a-z0-9.]+", "-", model.lower()).strip("-")


def frozen_env(model: str, overrides: dict[str, object] | None = None) -> dict[str, str]:
    """The frozen knobs as process env (process env > .env > defaults) plus
    the single varying axis. LLM_TEAM_MODELS is forced blank — the sweep's
    axis is the GLOBAL model; a .env team split would silently fork brains.

    `overrides` is the Phase 3b sensitivity axis: it may only REPLACE a knob the
    frozen config already pins, never introduce one. Varying something the
    baseline never pinned would measure a compose default against a frozen
    value, and the frozen file itself is never written — an axis run leaves it
    byte-identical."""
    frozen = json.loads(FROZEN_PATH.read_text(encoding="utf-8"))["frozen"]
    env = {k: str(v) for k, v in frozen.items() if k.isupper()}
    env["LLM_MODEL_OLLAMA"] = model
    env["LLM_TEAM_MODELS"] = ""
    env["LLM_PROVIDER"] = "ollama"
    for key, value in (overrides or {}).items():
        if key not in env:
            raise RuntimeError(
                f"axis {key} is not a knob the frozen config pins — a sensitivity "
                "axis may only replace a frozen value (bench/race/frozen-config.json "
                "-> frozen), never introduce an unpinned one")
        env[key] = str(value)
    return env


def assert_single_axis(env: dict[str, str], axis: str | None,
                       axis_value: str | None) -> None:
    """The treatment must differ from the frozen baseline in EXACTLY the
    declared axis.

    This is the half of the guarantee a container printenv check cannot give:
    printenv proves the container received what the sweep asked for;
    this proves what the sweep asked for was one knob off baseline."""
    frozen = json.loads(FROZEN_PATH.read_text(encoding="utf-8"))["frozen"]
    baseline = {k: str(v) for k, v in frozen.items() if k.isupper()}
    drift = {k for k, v in baseline.items() if env.get(k) != v}
    expected = ({axis} if axis and str(baseline.get(axis)) != str(axis_value)
                else set())
    if drift != expected:
        raise RuntimeError(
            f"env differs from the frozen baseline in {sorted(drift)}, expected "
            f"{sorted(expected)} — a sensitivity sweep varies ONE axis")
    if axis:
        log(f"single-axis check OK: {axis}={env[axis]} (baseline "
            f"{baseline[axis]}), every other frozen knob at baseline")


def load_axes() -> dict:
    return json.loads(FROZEN_PATH.read_text(encoding="utf-8")).get(
        "sensitivityAxes", {})


def rcon(command: str) -> str:
    return subprocess.run(
        ["docker", "exec", MINECRAFT_CONTAINER, "rcon-cli", command],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def race_usernames(frozen: dict) -> list[str]:
    """Minecraft usernames of the frozen 3v3 roster, resolved through the
    single-source seed file (never a fourth hardcoded name table).

    A raw player COUNT cannot stand in for these: the POV rig keeps six
    `pov_cam_*` bots logged in, so `list` reports 12 with a full fleet and
    still reports 6 with every villager missing."""
    entries = json.loads(
        (REPO_ROOT / "services" / "agent-service" / "seed" / "villagers.json")
        .read_text(encoding="utf-8"))
    wanted = {vid for ids in frozen["roster"].values() for vid in ids}
    names = [e.get("minecraftUsername", e["name"]) for e in entries
             if e["id"] in wanted]
    if len(names) != len(wanted):
        raise RuntimeError(
            f"roster mismatch: frozen config names {len(wanted)} villager ids, "
            f"villagers.json resolves {len(names)} — reseed before racing")
    return names


def restore_world(snapshot: Path, seed: str, usernames: list[str]) -> None:
    """Put the pristine pinned-seed world back before a model block (v3
    protocol). Blocked run order means wear used to accumulate across a whole
    block and correlate with run index — this is what removes it.

    Wipe-then-extract, not extract-over: a leftover region file from the
    previous block is exactly the wear this is meant to delete."""
    if not snapshot.is_file():
        raise RuntimeError(f"world snapshot not found: {snapshot} "
                           "— see docs/runbooks/race-world-reset.md")
    log(f"restoring pristine world from {snapshot.name}")
    subprocess.run([*COMPOSE_MC, "stop", "minecraft"],
                   check=True, cwd=REPO_ROOT, capture_output=True, text=True)
    subprocess.run(
        ["docker", "run", "--rm",
         "-v", f"{WORLD_VOLUME}:/data",
         "-v", f"{snapshot.parent}:/backup:ro",
         "alpine", "sh", "-c",
         f"rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/{snapshot.name} -C /data"],
        check=True, cwd=REPO_ROOT, capture_output=True, text=True,
    )
    subprocess.run([*COMPOSE_MC, "up", "-d", "--wait", "minecraft"],
                   check=True, cwd=REPO_ROOT, capture_output=True, text=True)

    # The seed check is the honesty gate for the world axis: if the snapshot
    # was taken from the wrong volume, every duration in the block is measured
    # on a different map and the table is silently comparing terrain.
    # Exact numeric compare, not substring containment: Paper prints
    # "Seed: [6233701440491701965]", and the sign-flipped seed
    # -6233701440491701965 CONTAINS the pinned string while being a different
    # world. A benchmark gate that can be passed by the wrong map is not a gate.
    got_seed = rcon("seed")
    m = re.search(r"-?\d+", got_seed)
    if not m or m.group(0) != seed:
        raise SeedGateError(f"world seed mismatch after restore: {got_seed!r} "
                            f"is not exactly {seed} — refusing to race")
    log(f"world restored, seed verified ({seed})")

    # Bots auto-reconnect with exponential backoff (BotSession.ts, capped 60s);
    # connection-throttle is patched to -1 every boot, so the herd is admitted
    # at once. Race preflight still needs them ONLINE — probed PER NAME with
    # `execute if entity`, never by parsing `list`: the POV rig's six cam bots
    # would satisfy any count-based gate, and RCON ellipsizes long output
    # server-side (~150 chars), so with enough players online `list` silently
    # drops names past the cutoff and an online racer reads as missing
    # (cost three ctx blocks on 2026-07-26, 26 players online).
    deadline = time.monotonic() + 300
    missing: list[str] = list(usernames)
    while time.monotonic() < deadline:
        missing = [n for n in usernames
                   if "Test passed" not in rcon(f"execute if entity {n}")]
        if not missing:
            log(f"fleet back online ({len(usernames)} villagers: {', '.join(usernames)})")
            return
        time.sleep(10)
    raise RuntimeError(f"villagers still offline after 300s: {', '.join(missing)} "
                       f"— last list: {rcon('list')!r}")


def recreate_memory_service(env: dict[str, str]) -> None:
    """Reflection temperature is read at boot. Compose did not pass
    LLM_TEMPERATURE to memory-service at all before v3, so every v1/v2 run
    summarised memories at the 0.7 default while calling itself greedy."""
    log(f"recreating memory-service with LLM_TEMPERATURE={env['LLM_TEMPERATURE']}")
    subprocess.run(
        [*COMPOSE, "up", "-d", "--no-deps", "memory-service"],
        check=True, env={**os.environ, **env}, cwd=REPO_ROOT,
        capture_output=True, text=True,
    )
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if httpx.get(MEMORY_HEALTH, timeout=5).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(5)
    else:
        raise RuntimeError("memory-service did not become healthy in 180s")

    printenv = subprocess.run(
        ["docker", "exec", MEMORY_CONTAINER, "printenv"],
        check=True, capture_output=True, text=True,
    ).stdout
    got = dict(line.split("=", 1) for line in printenv.splitlines() if "=" in line)
    # The budget is verified alongside the temperature because its failure mode
    # is silent: a tripped reflection breaker keeps the honesty gate green.
    for key in ("LLM_TEMPERATURE", "REFLECTION_ENABLED",
                "REFLECTION_DAILY_TOKEN_BUDGET"):
        want = env.get(key, "")
        if got.get(key, "") != want:
            raise RuntimeError(
                f"memory-service {key}={got.get(key)!r}, want {want!r} — "
                "reflections would run off-protocol")
    log("memory-service env verified (reflection temperature + budget pinned)")


def recreate_agent_service(env: dict[str, str]) -> None:
    log(f"recreating agent-service with LLM_MODEL_OLLAMA={env['LLM_MODEL_OLLAMA']}")
    subprocess.run(
        [*COMPOSE, "up", "-d", "--no-deps", "agent-service"],
        check=True, env={**os.environ, **env}, cwd=REPO_ROOT,
        capture_output=True, text=True,
    )
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if httpx.get(AGENT_HEALTH, timeout=5).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(5)
    else:
        raise RuntimeError("agent-service did not become healthy in 180s")

    # The post-merge discipline: verify the config is IN the container.
    printenv = subprocess.run(
        ["docker", "exec", AGENT_CONTAINER, "printenv"],
        check=True, capture_output=True, text=True,
    ).stdout
    got = dict(line.split("=", 1) for line in printenv.splitlines() if "=" in line)
    verify = ("LLM_MODEL_OLLAMA", "LLM_TEMPERATURE", "LLM_TEAM_MODELS",
              "TICK_INTERVAL_SECONDS", "VILLAGER_COUNT", "OLLAMA_NUM_CTX",
              "LLM_DAILY_TOKEN_BUDGET")
    # `got.get(k, "") != env.get(k, "")` passes VACUOUSLY when a key is absent
    # from both sides — an unpinned knob would verify green against a container
    # that never received it. Fail on the typo instead of on the data.
    absent = [k for k in verify if k not in env]
    if absent:
        raise RuntimeError(f"verify keys absent from the effective env: {absent}")
    for key in verify:
        if got.get(key, "") != env[key]:
            raise RuntimeError(
                f"container env mismatch: {key}={got.get(key)!r}, want {env[key]!r} "
                "— refusing to race on a misconfigured brain")
    # Derived from env, not prose: the old hardcoded line would have printed
    # "temperature 0.0, team split off" during a run that varied neither.
    log("agent-service env verified: "
        + ", ".join(f"{k}={env[k]}" for k in verify))


def warm_model(model: str, num_ctx: int) -> None:
    """Load the model at the ARM's num_ctx so run 1's first deliberations aren't
    skewed by cold-load latency (a 12B load is minutes on first touch). The ctx
    axis changes this value, so warming at a hardcoded 8192 would leave every
    non-baseline ctx arm paying a runner reload inside its first race."""
    log(f"warming {model} (num_ctx {num_ctx})")
    r = httpx.post(
        f"{OLLAMA}/api/generate",
        json={"model": model, "prompt": "ok", "stream": False,
              "options": {"num_ctx": num_ctx}, "keep_alive": "15m"},
        timeout=600,
    )
    r.raise_for_status()
    log(f"warm: {model} loaded")


def race_timeout_seconds(tick_seconds: int) -> int:
    """Process bound for one race, scaled by the tick arm.

    The 75-minute watchdog inside race-rb2.mjs is INTER-MILESTONE, not total, so
    it does not bound a run: the existing manifest holds a 5544.8 s DNF against
    a 6600 s process bound — 13% headroom. Halving the decision rate stretches
    the progress phase proportionally and would push that run into a
    timeout-kill, which is discarded and rerun; after the rerun budget the arm
    silently loses N. Scaling the bound with the tick keeps the censoring from
    landing on exactly the slow arm."""
    progress_budget = RACE_TIMEOUT_SECONDS - STALL_WATCHDOG_SECONDS
    return int(STALL_WATCHDOG_SECONDS + progress_budget * (tick_seconds / BASELINE_TICK))


def run_race(label: str, difficulty: str, timeout_seconds: int,
             extra_args: list[str] | None = None) -> tuple[int, str | None]:
    """One race-rb2 take. Returns (exit code, attempt id or None); full stdout
    tees to bench/results/sweep/logs/<label>.log."""
    logs_dir = SWEEP_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"{label}.log"
    cmd = ["node", str(REPO_ROOT / "scripts" / "race-rb2.mjs"),
           "--label", label, "--difficulty", difficulty, *(extra_args or [])]
    log(f"race: {' '.join(cmd[1:])} (timeout {timeout_seconds}s)")
    with log_path.open("w", encoding="utf-8") as fh:
        proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT,
                                cwd=REPO_ROOT, text=True)
        try:
            code = proc.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            code = -1
    text = log_path.read_text(encoding="utf-8")
    m = re.search(r"attempt (\S+) STARTED", text)
    return code, m.group(1) if m else None


def extract(attempt_id: str, label: str) -> dict:
    """Tier A + Tier B off the live ledger; raw slices dumped for offline
    re-extraction and the Tier B fixture."""
    name_of, team_of = bench_race.load_roster()
    attempt_events, villager_events = bench_race.fetch_attempt(
        attempt_id, bench_race.DEFAULT_LEDGER)
    # extract_pair, not tier_a/tier_b by hand: Tier B's tokensPerMinute needs
    # Tier A's durationSeconds, and one shared pairing keeps the live sweep and
    # `bench_race.py --reextract` computing byte-identical results.
    result = bench_race.extract_pair(attempt_events, villager_events, name_of, team_of)
    bench_race.write_results(result, label)
    slices_dir = SWEEP_DIR / "slices"
    slices_dir.mkdir(parents=True, exist_ok=True)
    (slices_dir / f"{label}.slice.json").write_text(
        json.dumps({"data": attempt_events}, indent=2) + "\n", encoding="utf-8")
    (slices_dir / f"{label}.window.json").write_text(
        json.dumps({"data": villager_events}, indent=2) + "\n", encoding="utf-8")
    return result


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {"benchmark": "rb-race-sweep", "frozenConfig": "bench/race/frozen-config.json",
            "startedAt": now_iso(), "runs": []}


def save_manifest(manifest: dict) -> None:
    SWEEP_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def run_key(rec: dict) -> tuple:
    """Resume identity of one run.

    Every component is something that, if different, means the row is NOT a
    substitute for the run being planned:

    * `sweepKind` / `axis` / `axisValue` — a tick-60 sensitivity run must never
      satisfy the model table's todo list, nor the reverse. Legacy rows carry
      no sweepKind and key as model-table rows, so a v1/v2 resume still finds
      all 30 of them.
    * `configVersion` — a harness bump re-benches from scratch.
    * `worldSeed` — a `--no-world-reset` row must not satisfy a seeded sweep,
      or the block is skipped and unreset runs publish under a version whose
      defining claim is that the world IS reset.

    axisValue is stringified on both sides so 60 and "60" cannot fork a key.
    """
    return (rec.get("sweepKind", "model"),
            rec["model"],
            int(rec["index"]),
            rec.get("configVersion", 1),
            rec.get("worldSeed"),
            rec.get("axis"),
            None if rec.get("axisValue") is None else str(rec["axisValue"]))


def kept(manifest: dict, key: tuple) -> bool:
    return any(run_key(r) == key and not r["discarded"]
               for r in manifest["runs"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", required=True,
                    help="comma-separated Ollama model tags, block order")
    ap.add_argument("--runs", type=int, default=5, help="kept runs per model (N)")
    ap.add_argument("--world-snapshot", type=Path,
                    help="pristine pinned-seed world tarball, restored before "
                         "every model block (v3 protocol; required unless "
                         "--no-world-reset)")
    ap.add_argument("--no-world-reset", action="store_true",
                    help="skip the per-block world restore. Runs stay honest "
                         "but inherit the v1/v2 wear confound — they are NOT "
                         "protocol-complete v3 and are labelled as such")
    ap.add_argument("--axis",
                    help="Phase 3b sensitivity sweep: the ONE frozen knob to "
                         "vary (a key of sensitivityAxes in the frozen config). "
                         "Absent = model-comparison sweep, unchanged")
    ap.add_argument("--axis-values",
                    help="comma-separated arm values for --axis, in block "
                         "order; must include the axis baseline (the control)")
    ap.add_argument("--stop-on-dirty", action="store_true",
                    help="halt the whole sweep the first time a run trips the "
                         "honesty gate, instead of discarding and rerunning. "
                         "For unattended runs where a polluted run is a "
                         "situation to look at, not a retry")
    ap.add_argument("--max-consecutive-dnf", type=int, default=0,
                    help="halt after N consecutive honest DNFs (0 = off). A "
                         "run of DNFs usually means the arm or the environment "
                         "is broken; burning the rest of the budget on it "
                         "destroys nothing but tells you nothing either")
    args = ap.parse_args()

    frozen = json.loads(FROZEN_PATH.read_text(encoding="utf-8"))
    difficulty = frozen["frozen"]["difficulty"]
    world = frozen["frozen"].get("world", {})
    config_version = frozen.get("configVersion", 1)
    version_tag = "" if config_version == 1 else f"-v{config_version}"
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    axes = load_axes()

    # ---- arms: [(axis, axisValue, overrides)] — one entry in model mode -----
    if args.axis:
        if args.axis in ("LLM_MODEL_OLLAMA", "LLM_TEAM_MODELS"):
            ap.error(f"{args.axis} is the MODEL table's axis (varyingAxis), not "
                     "a sensitivity axis — run without --axis")
        spec = axes.get(args.axis)
        if not spec:
            ap.error(f"unknown axis {args.axis} — declared axes: "
                     f"{', '.join(sorted(axes)) or '(none)'}")
        if spec.get("runnable") is False:
            ap.error(f"axis {args.axis} is marked not runnable under this frozen "
                     f"config: {spec.get('$note', 'see frozen-config.json')}")
        if not args.axis_values:
            ap.error("--axis-values is required with --axis")
        # Both sides through str(): the config's values are JSON ints, the CLI
        # yields strings, and `"60" in [15, 30, 60]` is False.
        declared = [str(v) for v in spec["values"]]
        wanted = [v.strip() for v in args.axis_values.split(",") if v.strip()]
        unknown = [v for v in wanted if v not in declared]
        if unknown:
            ap.error(f"axis values {unknown} are not declared for {args.axis} "
                     f"(declared: {', '.join(declared)})")
        baseline = str(spec["baseline"])
        if baseline not in wanted:
            ap.error(f"an axis sweep without its baseline arm has no control — "
                     f"add {baseline} to --axis-values")
        arms = [(args.axis, v, {args.axis: v}) for v in wanted]
        interleave = spec.get("armOrder") == "interleaved"
        log(f"sensitivity sweep: {args.axis} arms {wanted} (baseline {baseline}), "
            f"{'interleaved by run index' if interleave else 'blocked by arm'}")
    else:
        arms = [(None, None, {})]
        interleave = False

    if args.no_world_reset:
        world_seed = None
        log("WARNING: --no-world-reset — per-block world restore is OFF, wear "
            "confound is back; rows recorded with worldSeed null")
    else:
        if not args.world_snapshot:
            ap.error("--world-snapshot is required unless --no-world-reset "
                     "(build one: docs/runbooks/race-world-reset.md)")
        world_seed = world.get("seed")
        if not world_seed:
            ap.error("frozen config has no frozen.world.seed — cannot verify "
                     "a restored world; fix the config before spending GPU-hours")

    # Pinned team posts (v3). A deterministic world with posts re-derived per
    # run leaves the start conditions to `locate biome`'s tie-breaking — and on
    # the pinned seed that command picks a lake for blue, which cannot be
    # stationed at all. Absent from the config = auto-locate, unchanged.
    post_args: list[str] = []
    for team in ("red", "blue"):
        anchor = (world.get("posts") or {}).get(team)
        if anchor:
            post_args += [f"--{team}", ",".join(str(v) for v in anchor)]
    if post_args:
        log(f"pinned posts: {' '.join(post_args)}")

    manifest = load_manifest()
    preflight_failures = 0
    consecutive_dnf = 0

    # Reflection temperature is a boot-time read and is model-independent:
    # once, before the blocks, then verified in the container.
    recreate_memory_service(frozen_env(models[0]))

    # Units of work, in execution order. An interleaved axis rotates the arms
    # per run index so arm order is not confounded with the arm — the same
    # mistake the v3 world reset exists to undo, one level down. A blocked axis
    # (num_ctx) keeps arms contiguous because switching forces an Ollama runner
    # reload, and pays for it with a stated order caveat instead.
    units: list[tuple[str, tuple, int]] = []
    for model in models:
        if interleave and len(arms) > 1:
            for index in range(1, args.runs + 1):
                shift = (index - 1) % len(arms)
                for arm in arms[shift:] + arms[:shift]:
                    units.append((model, arm, index))
        else:
            for arm in arms:
                for index in range(1, args.runs + 1):
                    units.append((model, arm, index))

    current: tuple | None = None       # (model, arm) whose setup is live
    failed_setups: set[tuple] = set()

    for model, arm, index in units:
        axis, axis_value, overrides = arm
        # Hashable identity for the live-setup / failed-setup bookkeeping: the
        # arm tuple carries the overrides DICT, which cannot key a set.
        arm_key = (model, axis, axis_value)
        axis_slug = axes.get(axis, {}).get("slug") if axis else None
        key = run_key({"sweepKind": "axis" if axis else "model", "model": model,
                       "index": index, "configVersion": config_version,
                       "worldSeed": world_seed, "axis": axis,
                       "axisValue": axis_value})
        if kept(manifest, key):
            continue
        if arm_key in failed_setups:
            continue

        env = frozen_env(model, overrides)
        tick = int(env["TICK_INTERVAL_SECONDS"])
        timeout_seconds = race_timeout_seconds(tick)

        if current != arm_key:
            # One bad block must not cost the remaining GPU-hours of an
            # unattended sweep: record it and move to the next arm.
            try:
                assert_single_axis(env, axis, axis_value)
                if world_seed:
                    restore_world(args.world_snapshot.resolve(), world_seed,
                                  race_usernames(frozen))
                recreate_agent_service(env)
                warm_model(model, int(env["OLLAMA_NUM_CTX"]))
            except SeedGateError:
                log("SEED GATE TRIPPED — stopping the sweep. The restored world "
                    "is not the pinned world; every later row would be measured "
                    "on different terrain. Evidence left in place, nothing retried.")
                save_manifest(manifest)
                return 4
            except Exception as exc:  # noqa: BLE001 — unattended sweep outlives one bad block
                failed_setups.add(arm_key)
                manifest["runs"].append({
                    "model": model, "index": index,
                    "label": f"setup-{slug(model)}"
                             + (f"-{axis_slug}-{slug(str(axis_value))}" if axis else ""),
                    "sweepKind": "axis" if axis else "model",
                    "axis": axis, "axisValue": axis_value,
                    "axisBaseline": (str(axes[axis]["baseline"]) if axis else None),
                    "configVersion": config_version, "worldSeed": world_seed,
                    "attemptId": None, "outcome": "block-setup-failed",
                    "honest": None, "discarded": True,
                    "reason": f"block setup failed: {exc}", "at": now_iso(),
                })
                save_manifest(manifest)
                log(f"block setup FAILED for {model} arm {axis}={axis_value}: "
                    f"{exc} — skipping this block, continuing sweep")
                current = None
                continue
            current = arm_key

        record_axis = {
            "sweepKind": "axis" if axis else "model",
            "axis": axis, "axisValue": axis_value,
            "axisBaseline": (str(axes[axis]["baseline"]) if axis else None),
            "frozenOverrides": {k: str(v) for k, v in overrides.items()},
            "stallMinutes": STALL_WATCHDOG_SECONDS // 60,
            "raceTimeoutSeconds": timeout_seconds,
        }

        for attempt_no in range(MAX_DIRTY_RERUNS + 1):
            suffix = "" if attempt_no == 0 else chr(ord("b") + attempt_no - 1)
            label = (f"bench-{slug(model)}{version_tag}-r{index}{suffix}"
                     if not axis else
                     f"sens-{axis_slug}-{slug(str(axis_value))}-{slug(model)}"
                     f"-v{config_version}-r{index}{suffix}")
            # --expect-tick asserts EQUALITY with the arm in the preflight.
            # Relaxing the harness's <=30 bound to the arm value instead
            # would degrade the check to "matches what I asked for".
            code, attempt_id = run_race(
                label, difficulty, timeout_seconds,
                ["--expect-tick", str(tick), *post_args])

            if code == 3 or attempt_id is None:
                preflight_failures += 1
                log(f"{label}: preflight/launch FAILED (exit {code}) — "
                    f"{preflight_failures} consecutive")
                if preflight_failures >= 2:
                    log("two consecutive preflight failures — environment "
                        "broken, aborting sweep (see sweep logs)")
                    return 3
                time.sleep(60)
                continue  # retry same index, next letter
            preflight_failures = 0

            if code == -1:
                # timeout-killed: the attempt may be orphaned live; the
                # next take's harness aborts stale attempts itself.
                manifest["runs"].append({
                    "model": model, "index": index, "label": label,
                    "configVersion": config_version,
                    "worldSeed": world_seed, **record_axis,
                    "attemptId": attempt_id, "outcome": "orphaned",
                    "honest": None, "discarded": True,
                    "reason": "race process timeout-killed", "at": now_iso(),
                })
                save_manifest(manifest)
                log(f"{label}: TIMEOUT-KILLED, discarded — rerunning")
                continue

            time.sleep(LEDGER_SETTLE_SECONDS)
            try:
                result = extract(attempt_id, label)
            except Exception as exc:  # noqa: BLE001 — unattended sweep must outlive one bad attempt
                manifest["runs"].append({
                    "model": model, "index": index, "label": label,
                    "configVersion": config_version,
                    "worldSeed": world_seed, **record_axis,
                    "attemptId": attempt_id, "outcome": "extract-failed",
                    "honest": None, "discarded": True,
                    "reason": f"extraction failed: {exc}", "at": now_iso(),
                })
                save_manifest(manifest)
                log(f"{label}: extraction FAILED ({exc}) — discarded, rerunning")
                continue
            a = result["tierA"]
            honest = a.get("honestRace") or {}
            clean = (honest.get("fakeProviderDelta") == 0
                     and honest.get("budgetTrippedDelta") == 0)
            record = {
                "model": model, "index": index, "label": label,
                "configVersion": config_version,
                "worldSeed": world_seed, **record_axis,
                "attemptId": attempt_id,
                "outcome": a.get("outcome"),
                "winner": a["winner"]["team"] if a.get("outcome") == "won" else None,
                "durationSeconds": a.get("durationSeconds"),
                "honest": honest, "discarded": not clean,
                "resultFile": f"bench/results/race_{label}.json",
                "at": now_iso(),
            }
            if not clean:
                record["reason"] = "polluted honestRace deltas"
            manifest["runs"].append(record)
            save_manifest(manifest)
            log(f"{label}: {a.get('outcome')} in {a.get('durationSeconds')}s, "
                f"honest {honest} — {'KEPT' if clean else 'DISCARDED (dirty)'}")
            if not clean and args.stop_on_dirty:
                log("HONESTY GATE TRIPPED and --stop-on-dirty is set — stopping "
                    f"the sweep. Evidence preserved: {label} in the manifest, "
                    f"slices in {SWEEP_DIR / 'slices'}, log in "
                    f"{SWEEP_DIR / 'logs' / (label + '.log')}. Not retried.")
                return 5
            if clean:
                # A stalled-but-honest run is a kept DNF — real signal, not a
                # failure. A RUN of them is a different claim: the arm or the
                # environment is broken, and the remaining budget would buy
                # more of the same non-answer.
                if a.get("outcome") == "won":
                    consecutive_dnf = 0
                else:
                    consecutive_dnf += 1
                    if (args.max_consecutive_dnf
                            and consecutive_dnf >= args.max_consecutive_dnf):
                        log(f"{consecutive_dnf} consecutive DNFs (limit "
                            f"{args.max_consecutive_dnf}) — stopping the sweep "
                            "with evidence intact; the rows are kept, nothing "
                            "was retried past this point.")
                        return 6
                break  # next index; stalled-but-honest is a kept DNF
        else:
            # A hole used to be a LOG LINE ONLY: the manifest kept no row,
            # so the arm silently finished with N-1 runs and nothing in the
            # data said which index vanished or why. Censoring that lands
            # preferentially on slow arms, which is exactly the direction
            # that flatters them.
            manifest["runs"].append({
                "model": model, "index": index, "label": label,
                "configVersion": config_version,
                "worldSeed": world_seed, **record_axis,
                "attemptId": None, "outcome": "no-clean-run",
                "honest": None, "discarded": True,
                "reason": f"no clean run in {MAX_DIRTY_RERUNS + 1} tries",
                "at": now_iso(),
            })
            save_manifest(manifest)
            log(f"{model} run {index}: no clean run in "
                f"{MAX_DIRTY_RERUNS + 1} tries — hole RECORDED in manifest")

    log("sweep complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
