# Runbook: race world reset & pinned-seed snapshot (v3 protocol)

The v1/v2 model sweeps ran every block on **one shared, never-reset world**.
Wear (stripped trees, mined-out coal near the posts, trampled paths) therefore
accumulated with run index, and run index correlates with model block — which
is exactly why `bench/results/RACE_REPORT.md` refuses every between-winner
ranking claim. v3 removes it: each model block starts from the same pristine
world, generated from a pinned seed, with day and weather frozen.

Seed: **`6233701440491701965`** (`SEED` in the minecraft service,
`frozen.world.seed` in `bench/race/frozen-config.json`).
Snapshot artifact: **`pristine-6233701440491701965-v3.tgz`**.

**Run everything below from PowerShell** — Git Bash mangles `-v /paths` in
`docker run` (CLAUDE.md gotcha). This is a superset of the old post-nuke
gamerule checklist: a restore re-applies all of it, so that checklist is
retired.

> **Destructive:** step 2 deletes the Minecraft world volume permanently. It
> touches `minecraft-data` ONLY — `postgres-data` (ledger, villagers,
> memories) and `redpanda-data` are untouched. Do **not** use `task nuke`
> here: it runs `down -v`, which takes Postgres, Redpanda and Grafana with it.
> If the current world holds anything you want, back it up first
> (`docs/runbooks/volume-backup.md`).

## The archived pre-v3 world

The world all 30 v1/v2 runs were raced on is kept, not discarded:
`D:\backups\ai-civilization-engine\pre-v3-world-1709071022456631449.tgz` — a
cold tar of the whole `minecraft-data` volume taken immediately before the v3
wipe. Its seed was read from the live server (`Seed: [1709071022456631449]`)
before replacement, and the same path is recorded in
`bench/results/sweep/manifest.json` (`$worldProtocol`) next to the 30 runs it
belongs to. Restore it the same way as any snapshot below if a past row's
terrain ever needs re-inspection.

## One-time: build the pristine snapshot

```powershell
$mc = 'infrastructure/docker/docker-compose.yml'
$compose = @('-f', $mc, '--env-file', '.env', '--profile', 'minecraft')

# 1. Seed is pinned in compose (new worlds only) — confirm before wiping
Select-String -Path $mc -Pattern 'SEED:'      # expect "6233701440491701965"

# 2. Scoped teardown of the WORLD ONLY
docker compose @compose stop minecraft
docker compose @compose rm -f minecraft
docker volume rm ai-civilization-engine_minecraft-data

# 3. Regenerate (first-boot world-gen ~25-60s; mc-health start_period is 90s)
docker compose @compose up -d --wait minecraft

# 4. Bake the world state the protocol assumes
$rcon = { param($c) docker exec ai-civilization-engine-minecraft-1 rcon-cli $c }
foreach ($c in @(
  'gamerule keepInventory true',
  'gamerule doInsomnia false',
  'gamerule mobGriefing false',
  'gamerule doMobSpawning false',
  'gamerule doDaylightCycle false',
  'gamerule doWeatherCycle false',
  'time set day',
  'weather clear',
  'save-all'
)) { & $rcon $c }

# 5. VERIFY the seed. No match = the env never took (an existing volume keeps
#    its own seed). Stop here — do NOT snapshot a wrong-seed world.
& $rcon 'seed'                                # expect 6233701440491701965

# 6. Cold stop, then tar the WHOLE volume
docker compose @compose stop minecraft
$dest = 'D:\backups\ai-civilization-engine'
New-Item -ItemType Directory -Force $dest | Out-Null
docker run --rm -v ai-civilization-engine_minecraft-data:/from `
  -v "${dest}:/to" alpine tar czf /to/pristine-6233701440491701965-v3.tgz -C /from .
docker run --rm -v "${dest}:/to:ro" alpine sh -c `
  "tar tzf /to/pristine-6233701440491701965-v3.tgz | wc -l"   # lists cleanly = not truncated
```

Difficulty is **not** baked here on purpose: `race-rb2.mjs` sets it per
attempt (`difficulty easy` → `save-all` → RCON read-back), which is the
closed-loop procedure for the level.dat override trap.

## Choosing team posts for a new seed (do this once, after step 6)

A pinned world needs pinned posts. Leaving them to `locate biome` makes the
start conditions a function of that command's tie-breaking, and on seed
`6233701440491701965` it picks **water** for blue: the auto-located post
(342,160) is water at y=62 with air above, so `spreadplayers` refuses it —
`Could not spread 1 entity/entities … try using spread of at most 0.00` — and
the preflight dies five confusing retries later without ever saying "water".

Pinned in `frozen.world.posts` (verified 2026-07-26): red `[-416, -192]`,
blue `[364, -583]` — 872 blocks apart, both `locate biome
#minecraft:is_forest` distance 0, both accepting `spreadplayers`. The `[x, z]`
two-value form keeps the existing spreadplayers stationing (a three-value
`[x, y, z]` would `tp` the whole team onto one block).

To re-derive on a different seed, the oracle is the operation that has to
succeed — not a terrain guess:

```powershell
$mc = 'ai-civilization-engine-minecraft-1'
# 1. does the anchor accept a player at all?
docker exec $mc rcon-cli "spreadplayers <X> <Z> 0 8 false Ansel"   # want "Spread ..."
# 2. where did it actually land, and is that a forest?
docker exec $mc rcon-cli "data get entity Ansel Pos"
docker exec $mc rcon-cli "execute positioned <X> <Y> <Z> run locate biome #minecraft:is_forest"
```

Accept an anchor only if it places, the landing elevation is sane (55–90), the
forest distance is ~0, and the two posts are ≥700 blocks apart. Check BOTH
posts for forest distance: red inside a forest and blue 32 blocks outside it is
a wood-availability head start, not a symmetric race.

## Per-block restore (what the sweep does automatically)

`bench/sweep_race.py --world-snapshot <path>` runs this before every model
block and aborts the sweep if the seed check fails:

1. `docker compose --profile minecraft stop minecraft`
2. wipe the volume contents and untar the snapshot in one throwaway alpine
   container (wipe-then-extract — a leftover region file IS the wear)
3. `docker compose --profile minecraft up -d --wait minecraft`
4. `rcon-cli seed` must contain `6233701440491701965`, else abort
5. wait for `rcon-cli list` to show ≥ `VILLAGER_COUNT` players — bots
   auto-reconnect (`BotSession.ts`, exponential backoff capped at 60s) and
   `connection-throttle: -1` is patched in every boot, so the herd is admitted
   at once instead of one bot per minute

A full restore also clears dropped items and any leftover placed blocks, so no
separate item sweep is needed between runs.

Manual equivalent:

```powershell
docker compose @compose stop minecraft
docker run --rm -v ai-civilization-engine_minecraft-data:/data `
  -v 'D:\backups\ai-civilization-engine:/backup:ro' alpine sh -c `
  "rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/pristine-6233701440491701965-v3.tgz -C /data"
docker compose @compose up -d --wait minecraft
docker exec ai-civilization-engine-minecraft-1 rcon-cli seed
docker exec ai-civilization-engine-minecraft-1 rcon-cli list
```

## What v3 does and does not fix

- **Fixed:** cross-block wear (every block starts identical), time-of-day and
  weather drift (frozen day, clear), and memory-service reflections running at
  0.7 while the run called itself greedy (compose now passes
  `LLM_TEMPERATURE`).
- **Not fixed:** within-block wear — run 5 of a block still plays a world that
  runs 1–4 chewed on. Interleaving run order within blocks is the upgrade;
  decide that **before** a sweep starts, not after.
- **Not fixed: villager memory and relationships.** The restore touches
  `minecraft-data` only — `postgres-data` (memory_db's memory stream,
  agent_db's relationship edges) is deliberately left alone, so a model raced
  in block 5 inherits everything blocks 1–4 accumulated. That is the same
  shape of confound as world wear, and v3 makes it stranger rather than
  smaller: carried-over memories now describe terrain that the reset deleted.
  Left alone on purpose — truncating villager memory is a filming-state
  decision (those memories are narrative truth for the YouTube arc), not a
  benchmark one. If a future protocol version does reset them, snapshot
  `postgres-data` first and treat it as a version bump, not a tweak.
- **Not comparable:** v3 numbers cannot be pooled with v1/v2 rows for any
  model. The aggregator already keys on `(model, configVersion)` and reports
  each model at its highest version.
