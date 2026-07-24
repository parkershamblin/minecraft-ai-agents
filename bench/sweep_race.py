"""Phase 2 RB-race model sweep — N runs per model under the frozen config
(bench/race/frozen-config.json, docs/benchmark-rb.md).

Blocked by model: one agent-service recreate per block (model env is read at
boot), the model stays GPU-resident for its whole block. Per run:

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
      --models llama3.1:8b,gemma3:12b --runs 5
"""

from __future__ import annotations

import argparse
import json
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
AGENT_HEALTH = "http://localhost:8001/healthz"
OLLAMA = "http://localhost:11434"

COMPOSE = [
    "docker", "compose",
    "-f", str(REPO_ROOT / "infrastructure" / "docker" / "docker-compose.yml"),
    "--env-file", str(REPO_ROOT / ".env"),
    "--profile", "infra", "--profile", "app",
]

# One rerun for a dirty (polluted) run, one for a preflight failure — a second
# consecutive preflight failure means the environment is broken and burning
# more GPU-hours unattended would be noise, so the sweep aborts loudly.
MAX_DIRTY_RERUNS = 2
RACE_TIMEOUT_SECONDS = 110 * 60  # 75m stall watchdog + preflight + margin
LEDGER_SETTLE_SECONDS = 10  # let the ledger consumer land the tail events


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


def slug(model: str) -> str:
    return re.sub(r"[^a-z0-9.]+", "-", model.lower()).strip("-")


def frozen_env(model: str) -> dict[str, str]:
    """The frozen knobs as process env (process env > .env > defaults) plus
    the single varying axis. LLM_TEAM_MODELS is forced blank — the sweep's
    axis is the GLOBAL model; a .env team split would silently fork brains."""
    frozen = json.loads(FROZEN_PATH.read_text(encoding="utf-8"))["frozen"]
    env = {k: str(v) for k, v in frozen.items() if k.isupper()}
    env["LLM_MODEL_OLLAMA"] = model
    env["LLM_TEAM_MODELS"] = ""
    env["LLM_PROVIDER"] = "ollama"
    return env


def recreate_agent_service(env: dict[str, str]) -> None:
    import os

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
    for key in ("LLM_MODEL_OLLAMA", "LLM_TEMPERATURE", "LLM_TEAM_MODELS",
                "TICK_INTERVAL_SECONDS", "VILLAGER_COUNT", "OLLAMA_NUM_CTX",
                "LLM_DAILY_TOKEN_BUDGET"):
        want = env.get(key, "")
        if got.get(key, "") != want:
            raise RuntimeError(
                f"container env mismatch: {key}={got.get(key)!r}, want {want!r} "
                "— refusing to race on a misconfigured brain")
    log("container env verified (model, temperature 0.0, team split off)")


def warm_model(model: str) -> None:
    """Load the model at the benchmark num_ctx so run 1's first deliberations
    aren't skewed by cold-load latency (a 12B load is minutes on first touch)."""
    log(f"warming {model} (num_ctx 8192)")
    r = httpx.post(
        f"{OLLAMA}/api/generate",
        json={"model": model, "prompt": "ok", "stream": False,
              "options": {"num_ctx": 8192}, "keep_alive": "15m"},
        timeout=600,
    )
    r.raise_for_status()
    log(f"warm: {model} loaded")


def run_race(label: str, difficulty: str) -> tuple[int, str | None]:
    """One race-rb2 take. Returns (exit code, attempt id or None); full stdout
    tees to bench/results/sweep/logs/<label>.log."""
    logs_dir = SWEEP_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / f"{label}.log"
    cmd = ["node", str(REPO_ROOT / "scripts" / "race-rb2.mjs"),
           "--label", label, "--difficulty", difficulty]
    log(f"race: {' '.join(cmd[1:])}")
    with log_path.open("w", encoding="utf-8") as fh:
        proc = subprocess.Popen(cmd, stdout=fh, stderr=subprocess.STDOUT,
                                cwd=REPO_ROOT, text=True)
        try:
            code = proc.wait(timeout=RACE_TIMEOUT_SECONDS)
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
    result = {
        "tierA": bench_race.tier_a(attempt_events, name_of),
        "tierB": bench_race.tier_b(villager_events, team_of),
    }
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


def kept(manifest: dict, model: str, index: int) -> bool:
    return any(r["model"] == model and r["index"] == index and not r["discarded"]
               for r in manifest["runs"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", required=True,
                    help="comma-separated Ollama model tags, block order")
    ap.add_argument("--runs", type=int, default=5, help="kept runs per model (N)")
    args = ap.parse_args()

    frozen = json.loads(FROZEN_PATH.read_text(encoding="utf-8"))
    difficulty = frozen["frozen"]["difficulty"]
    models = [m.strip() for m in args.models.split(",") if m.strip()]

    manifest = load_manifest()
    preflight_failures = 0

    for model in models:
        todo = [i for i in range(1, args.runs + 1) if not kept(manifest, model, i)]
        if not todo:
            log(f"block {model}: all {args.runs} runs already kept — skip")
            continue
        env = frozen_env(model)
        recreate_agent_service(env)
        warm_model(model)

        for index in todo:
            for attempt_no in range(MAX_DIRTY_RERUNS + 1):
                suffix = "" if attempt_no == 0 else chr(ord("b") + attempt_no - 1)
                label = f"bench-{slug(model)}-r{index}{suffix}"
                code, attempt_id = run_race(label, difficulty)

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
                if clean:
                    break  # next index; stalled-but-honest is a kept DNF
            else:
                log(f"{model} run {index}: no clean run in "
                    f"{MAX_DIRTY_RERUNS + 1} tries — leaving hole, see manifest")

    log("sweep complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
