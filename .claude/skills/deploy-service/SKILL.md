---
name: deploy-service
description: Use when deploying or restarting any service on the live stack — `up -d --build --no-deps`, `task up:all`, changing LLM config (.env, LLM_PROVIDER, budgets), recreating minecraft-service, provisioning Kafka topics, or deploying from a worktree. Delivers the safe-deploy checklist that proves the intended code AND config actually reached the container before any run.
---

## When to use / when not

Use for every deploy to the live stack: post-merge service rebuilds, LLM config
changes, fleet recovery after a minecraft-service recreate, worktree deploys,
and the post-deploy health gate. NOT for: world reset / pristine snapshots (see
the race-sweep skill), ledger queries or budget-trip pollution audits (see the
live-forensics skill — this skill only tells you WHEN to run that audit), and
the Docker Desktop crash ritual (CLAUDE.md "Permanent gotchas" owns it).
One live stack, one GPU: before driving docker/Minecraft/Ollama, check and
take `demos/.stack.lock` (lock protocol: see the demo-filming skill).

Base command used throughout (define once per shell):

```powershell
$COMPOSE = "docker compose -f infrastructure/docker/docker-compose.yml --env-file .env"
```

## 0. Shell-profile env sweep — BEFORE any LLM-config-affecting deploy

Compose interpolation takes **process env over `--env-file`** (documented in
`.env.example`: process env > file > defaults). This machine's shell profile
exports a stale race block (LLM_PROVIDER, LLM_TEAM_MODELS,
LLM_DAILY_TOKEN_BUDGET, VILLAGER_COUNT, TICK_INTERVAL_SECONDS…) — it silently
decided the first Anthropic deploy (2026-07-28, came up on ollama+team brains).

- [ ] Sweep: `Get-ChildItem env: | Where-Object Name -match 'LLM|VILLAGER|TICK'`
- [ ] Anything unexpected: `Remove-Item env:LLM_PROVIDER` (etc.) or open a clean shell
- [ ] After deploy, confirm in-container (step 2) — the sweep alone is not proof

## 1. Compose grammar: both profiles, three exceptions

Any compose command naming an individual app service needs
`--profile infra --profile app`, or cross-profile `depends_on` fails with
"depends on undefined service: invalid compose project".

| Service | Profile flags | Why |
|---|---|---|
| agent/memory/minecraft/event-service | `--profile infra --profile app` | depends_on crosses into infra |
| `minecraft` (Paper) | bare `--profile minecraft` | no depends_on — standalone |
| `pov-rig` | bare `--profile pov` | standalone by design; start/stop ONLY — never recreates the fleet |
| `government-service` | `--profile gov` | mothballed out of the app profile (ADR-10) |

## 2. The deploy: rebuild, then PROVE it landed

Plain `up` reuses the stale image — after ANY merge touching a service
(rb2-exit-1 raced 15 min on a 2h-old image; a new migration exits with
alembic "Can't locate revision" the same way). Container source paths come
from the Dockerfiles' WORKDIR: agent-service at `/repo/services/agent-service`,
minecraft-service at `/repo/services/minecraft-service`.

- [ ] Step 0 sweep done (if the deploy touches LLM config)
- [ ] `iex "$COMPOSE --profile infra --profile app up -d --build --no-deps <service>"`
- [ ] Health 200: agent `:8001/healthz`, memory `:8002/healthz`, minecraft-service `:8003/healthz`
- [ ] Marker grep — a symbol the merge introduced, inside the container:

```powershell
docker exec ai-civilization-engine-agent-service-1 grep -r "<marker_symbol>" /repo/services/agent-service/src
docker exec ai-civilization-engine-minecraft-service-1 grep -r "<marker_symbol>" /repo/services/minecraft-service/src
```

- [ ] printenv diff — EVERY key the run depends on, key-by-key against intended
      .env values; a key absent from BOTH sides is a FAILURE, not a pass
      (`bench/sweep_race.py` codifies this vacuous-compare guard):

```powershell
docker exec ai-civilization-engine-agent-service-1 printenv | Select-String -Pattern 'LLM_|TICK_|VILLAGER_'
```

## 3. The environment-block allowlist rule

A knob reaches a container ONLY if that service's compose `environment:` block
lists it — compose never forwards arbitrary .env keys, and the failure mode is
a silent code-default (memory-service ran every pre-v3 "greedy" benchmark's
reflections at 0.7 because `LLM_TEMPERATURE` wasn't forwarded; bit twice).
When a PR adds an env-read knob, the same PR adds it to the compose block.

Live examples of the trap (verified 2026-08-07 — env-read in
`services/minecraft-service/src/config.ts`, absent from the minecraft-service
compose block, so untunable in deployed containers):
`MOVE_MAX_DISTANCE`, all five `PLUGIN_*` flags (the documented
`PLUGIN_ARMOR_MANAGER=0` toggle cannot reach a compose fleet),
`COMMAND_MAX_AGE_SECONDS` (freshness window fixed at 600).

## 4. Fleet recovery after a minecraft-service recreate

Bot sessions are in-memory — every recreate/restore drops the whole fleet with
no error. Decision table:

| Situation | Tool |
|---|---|
| agent-service runs VILLAGER_COUNT > 0 | `task seed` (POST `:8001/internal/seed`) |
| Zero-pollution preset (VILLAGER_COUNT=0) | `node scripts/spawn-fleet.mjs [count]` — spawns ALL villagers.json entries (or first N) |
| Trim a live fleet to N bodies | `node scripts/despawn-fleet.mjs <keep>` — lowering VILLAGER_COUNT alone leaves surplus auto-reconnecting bodies |
| Race fleet of 6 | `node scripts/spawn-fleet.mjs` then `node scripts/despawn-fleet.mjs 6` (racers are villagers.json[0:6]) |

Gate recovery PER NAME — never by counting or parsing `list` (ellipsized at
~26 players, and POV cam bots satisfy any count gate):

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if entity Elara"   # "Test passed" iff online
```

## 5. Kafka topics: order and the mismatch rule

Auto-create is OFF in Redpanda, so producers beating provisioning fail loud.
Order is always infra → `task topics` → app (`task up:all` encodes it).
`node scripts/provision-topics.mjs` converges retention idempotently but
**exits 1 on partition mismatch — the ONLY fix is
`docs/runbooks/kafka-topic-migration.md`** (drain → stop consumers →
delete/recreate → group delete → reseed → keyed canary); add-partitions
rehashes villagerId keys and breaks per-villager ordering. Never hand-fix.

Hand-producing onto live topics: use the repo scripts
(`node scripts/produce-cmd.mjs <villagerId> <action> '<paramsJson>'` — keys by
villagerId, builds valid envelopes). Raw rpk onto a python-consumed topic
(world.events) MUST pass `-z none` — rpk's default snappy killed perception on
every boot, 2026-07-22 (`services/agent-service/pyproject.toml` pins the codecs).

## 6. Worktree deploys

- [ ] Copy .env in (gitignored, doesn't follow the worktree): `Copy-Item D:\Documents\GitHub\minecraft-ai-agents\.env <worktree>\.env`
- [ ] Compose from the worktree attaches to the SAME live project (`name: ai-civilization-engine`), so `up -d --build --no-deps <service>` deploys worktree code without recreating anything else — this is the intended mechanism, not a bug
- [ ] Distrust bind-mounted configs (prometheus.yml, grafana provisioning, minecraft-config patches, postgres-init): they resolve relative to the compose file each container was STARTED from — a worktree-side edit goes live only after merge + that container's restart
- [ ] Isolated parallel stack instead? Set `COMPOSE_PROJECT_NAME` (see `scripts/lib/containers.mjs`)

## 7. Never a deploy path

- `task dev:up` bind-mounts src + watchers — deployed provenance becomes the
  mounted worktree, not a built image. Rebuild from main before any
  honest/filmed run (`docker-compose.dev.yml` CAVEATS block).
- Never edit agent-service src mid-attempt: the reloader restarts the worker
  and in-memory RaceState forgets the race. A syntax error crashes the
  reloader silently — `docker logs` if a service goes quiet after an edit.

## 8. Post-deploy health: silence is not health

- [ ] Bring services up with `--wait` (every service except redpanda-console has a healthcheck — `--wait` still covers it via running state; Paper's mc-health has `start_period: 90s` for first-boot world-gen)
- [ ] Read restart COUNTS, not "Up" status — both Kafka consumers exit(1) on unrecoverable crash with `restart: on-failure` precisely so failure is visible here:

```powershell
docker inspect --format '{{.Name}} {{.RestartCount}}' ai-civilization-engine-agent-service-1 ai-civilization-engine-minecraft-service-1
```

- [ ] LLM deploys: `build_llm_provider` degrades silently down the chain (openai → anthropic → ollama → fake) — read the boot log before trusting a run:

```powershell
docker logs ai-civilization-engine-agent-service-1 2>&1 | Select-String "llm provider"
```

- [ ] Budget sized for the provider: compose default `LLM_DAILY_TOKEN_BUDGET` 2000000 is PAID-provider sizing — free Ollama runs need 100000000 or the breaker silently flips to FakeProvider (Sonnet at 6×30s burned 4M in ~69 min). After any trip, run the pollution audit — see the live-forensics skill.
- [ ] Paper health: `docker exec ai-civilization-engine-minecraft-1 rcon-cli mspt` — read the avg after the 1-minute window rolls past the world-gen spike.

## Verification

Prove you followed the skill — each command's output confirms a critical step:

```powershell
# Step 0: no stale race block in this shell
Get-ChildItem env: | Where-Object Name -match 'LLM|VILLAGER|TICK'          # expect: empty or intended values
# Step 2: new code is in the container
docker exec ai-civilization-engine-agent-service-1 grep -rc "<marker_symbol>" /repo/services/agent-service/src   # expect: >= 1 hit
# Step 2/3: config landed (and every expected key is PRESENT, not just equal)
docker exec ai-civilization-engine-agent-service-1 printenv | Select-String 'LLM_PROVIDER|LLM_DAILY_TOKEN_BUDGET|TICK_INTERVAL'
# Step 4: every roster name embodied
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if entity <name>"   # expect: "Test passed" per name
# Step 5: topics converged
node scripts/provision-topics.mjs                                          # expect: "topic map converged", exit 0
# Step 8: no crash loops, right brain
docker inspect --format '{{.Name}} {{.RestartCount}}' ai-civilization-engine-agent-service-1   # expect: 0
docker logs ai-civilization-engine-agent-service-1 2>&1 | Select-String "llm provider"          # expect: the intended provider
```
