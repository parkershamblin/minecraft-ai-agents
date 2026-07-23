# Fresh-Install Simulation — Findings

**Date:** 2026-07-22 → 2026-07-23
**Method:** Tier 1 — fresh clone of `main` into `D:\tmp\fresh-sim`, isolated via
`COMPOSE_PROJECT_NAME=fresh-sim` (fresh volumes, live stack stopped first), README
Quickstart followed verbatim. Deviations from README are logged below; nothing was
fixed mid-run.
**Scope:** does NOT test host-tool installation (all prerequisites pre-installed) —
that is Tier 2 (clean VM), not attempted.

**Environment tested with:** Windows 11 Pro · Docker 29.6.1 · Node v24.18.0
(README asks 22+) · go-task 3.52.0 · uv 0.11.22 · host Ollama running with
`llama3.1:8b` pulled.

## TL;DR

The README Quickstart does not survive first contact. Of its three steps, step 3
(`task smoke`) is broken on every fresh clone (F1), the Minecraft-server
prerequisite cannot be satisfied from the repo alone (F3), and even when all steps
pass, the Quickstart ends before the product exists — no app services, no
villagers, no dashboard (F2). With four logged workarounds, the full stack builds
clean from scratch and reaches 15/15 healthy containers, and end-to-end villager
verification passed on 2026-07-23: seeded villager embodied in-world, deliberating
on real Ollama (llama3.1:8b), full causation chains in the ledger, threat reflexes
firing. Teardown verified surgical — live volumes untouched. **Sim complete.**

## Findings

| # | Severity | Finding | Proposed fix |
|---|---|---|---|
| F1 | **high** | `task smoke` fails `MODULE_NOT_FOUND` on every fresh clone: `scripts/smoke.js:6` requires `../experiments/pathfinder-Bot/node_modules/mineflayer` — a gitignored PoC install that only exists on the original dev box. Comment says "Until minecraft-service exists (CIV-4)"; that service has existed since M1. | Point smoke at the workspace-installed service pin (root `npm install`; `services/minecraft-service` is already a workspace). |
| F2 | **high** | Quickstart ends at the canary. `cp .env` → `task up` → `task smoke` never starts the app profile, never seeds a villager, never shows the product. No `npm install`, no `task up:all`, no `task seed` mentioned. A new user finishes the README with zero villagers. | Rewrite Quickstart to end at "a villager is thinking": add `task up:all`, `task seed`, and a verification line (rcon `list` / ledger curl). |
| F3 | **high** | Server prerequisite unsatisfiable from the repo: README:53 assumes a host-run server in `../Minecraft 1.21.6 Server` (not shipped, no download/setup steps) and mentions "a containerized PaperMC profile exists as an alternative" **without the command**. | Add the working command to README: `docker compose ... --profile minecraft up -d --wait minecraft`, plus `MC_HOST=minecraft` note (see F6). |
| F4 | med | `.env.example` drifted from the live config surface: missing `COMMUNITY_GOAL` and `THREAT_DEFAULT_STANCE`; carries 4 vars the live `.env` lacks (`LLM_MAX_CONCURRENT_REQUESTS`, `POV_VIEW_DISTANCE`, `REFLECTIONS_PER_HOUR_CAP`, `REFLECTION_DAILY_TOKEN_BUDGET`). Fresh installs behave differently from the dev box. | Sync `.env.example` (smallest PR, do first). |
| F5 | med | The version-pin canary tests the wrong copy: smoke borrows the PoC's mineflayer pinned `^4.37.1` (caret), while the service pins exact `4.37.1`. Empirically the PoC lockfile currently holds `4.37.1` exactly, so drift is **latent**, not active — but one lockfile regen and the canary validates a version the service doesn't run. | Same fix as F1 — smoke must consume the service's exact pin. Drop the caret in the PoC regardless. |
| F6 | med | With the containerized server, bots connect **by accident**: `.env.example` default `MC_HOST=host.docker.internal` reaches the container only because Paper publishes `25565:25565` and the connection loops through the host port. Remove the publish, or occupy host 25565, and it breaks with no obvious cause. Intended config is `MC_HOST=minecraft`. | Document the pairing in README + `.env.example`: containerized profile ⇒ `MC_HOST=minecraft`. |
| F7 | med | Dashboard unstartable by a fresh installer: absent from compose (port 3000 exists only as a comment at `docker-compose.yml:117`), no host-run instructions anywhere, needs an undocumented root `npm install`. | Either a compose service in the app profile or documented host-run steps. |
| F8 | med (robustness) / low (for fresh install) | Nine `scripts/*.mjs` hardcode `ai-civilization-engine-*` container names; only `provision-topics.mjs` has an env escape hatch (`REDPANDA_CONTAINER`). Any non-default compose project name breaks all of them. A true fresh install (default name) is unaffected — this bit the sim harness, not the README path. | Shared helper: prefix from `COMPOSE_PROJECT_NAME ?? 'ai-civilization-engine'`, used by all 9 scripts. |
| F9 | low (predicted, not hit) | Fresh `minecraft-data` volume = post-nuke Paper defaults: `spawn-protection=16` (ghost digs) and `connection-throttle=4000` (one bot reconnect per minute after restarts). Didn't affect the single smoke bot; will affect any fleet on a fresh volume. Already documented as a re-apply-after-nuke gotcha in CLAUDE.md. | Bake overrides into the compose profile (env/config mount) instead of hand-editing the volume. |
| F10 | info | `npm install` in the archived PoC reports 6 moderate vulnerabilities + deprecated `uuid`. Archived code, becomes moot if F1/F5 fix removes the dependency on it. | None beyond F1. |

## Status

**Verified working from fresh clone (with the deviations below):**

- `task up`: infra 6/6 healthy, topics provisioned (6 topics, correct partitions/retention).
- Containerized Paper: healthy in ~35s on a fresh volume.
- `task smoke`: PASS (spawn + chat against containerized server).
- `task up:all`: 4 service images build clean from scratch (~67s), full stack 15/15 healthy — agent, memory, minecraft, event services all up.

**End-to-end verification — all five passed (2026-07-23 ~04:10–04:20Z):**

1. `task seed` → `{"seeded":[],"existing":["Elara"]}` — idempotent (villager existed from an earlier seed; re-run created nothing, broke nothing).
2. Provider real, not fake: boot log `llm provider: ollama (warmed)` with `llama3.1:8b` after walking the chain past the blank OpenAI key; every `DecisionMade` event stamps `llmProvider: ollama`, latencies 1.1–1.3s, 970–1469 tokens — physically incompatible with the fake provider. No fake fingerprints in chat content.
3. Bot in world: `rcon-cli list` → "There are 1 of a max of 30 players online: Elara".
4. Ledger flowing with full causation chains: `VillagerCreated → ActionRequested(spawn) → VillagerSpawned → ActionCompleted → DecisionMade → VillagerTalked → MemoryFormed`, plus live threat handling (skeleton + enderman flee, and a correct `ActionFailed{SELF_DEFENSE_IN_PROGRESS}` rejecting a move mid-flee). Note for future readers: the response envelope is `{data: [...], nextCursor}` — not `items`.
5. Teardown surgical: `down -v` (all three profiles) removed exactly the 6 `fresh-sim_*` volumes; all 6 `ai-civilization-engine_*` volumes verified intact before and after. Clone directory deleted. Live stack restored via `task up:all` — 10/10 healthy; `government-service` (exited 5 days prior, mothballed) and `pov-rig` (exited 3h prior) left in their pre-sim states; host Minecraft server left stopped (interactive console — start manually when needed).

## Deviations from README (logged, in order)

1. `$env:COMPOSE_PROJECT_NAME='fresh-sim'` — sim isolation harness, not a README step. Surfaced F8.
2. `$env:REDPANDA_CONTAINER='fresh-sim-redpanda-1'` — unblock for F8's collision with the harness.
3. Started containerized Paper via compose profile — README names the profile but gives no command (F3).
4. `npm install --prefix experiments/pathfinder-Bot` — undocumented requirement of `task smoke` (F1); resolved mineflayer to exactly 4.37.1 (evidence for F5's "latent, not active").
5. Extended phase beyond README: `task up:all` (README never mentions it — F2).

## Shipping status (2026-07-23) — audit fully closed out

1. **MERGED:** [#74](https://github.com/parkershamblin/ai-civilization-engine/pull/74) sync `.env.example` (F4).
2. **MERGED:** [#75](https://github.com/parkershamblin/ai-civilization-engine/pull/75) smoke reads the workspace mineflayer pin (F1 + F5; PoC caret left as noted residual — archived code).
3. **MERGED:** [#76](https://github.com/parkershamblin/ai-civilization-engine/pull/76) README Quickstart rewrite (F2 + F3 + F6 + F7 status line).
4. **Issues filed:** [#77](https://github.com/parkershamblin/ai-civilization-engine/issues/77) container-name helper across scripts (F8) · [#78](https://github.com/parkershamblin/ai-civilization-engine/issues/78) dashboard run story (F7) · [#79](https://github.com/parkershamblin/ai-civilization-engine/issues/79) Paper defaults baked into the profile (F9).

Every finding is now either merged (F1–F6, F7 status line) or tracked
(F7 decision, F8, F9). F10 was informational only.

## Log (decisive excerpts)

### task up — first run: F8 collision

```
task: [up] node scripts/provision-topics.mjs
Error: Command failed: docker exec ai-civilization-engine-redpanda-1 rpk topic list
Error response from daemon: No such container: ai-civilization-engine-redpanda-1
task: Failed to run task "up": exit status 1
```

Infra itself was already green (6/6 healthy, `fresh-sim_*` volumes freshly created).
After deviation 2, re-run: all 6 topics `created`, "topic map converged".

### task smoke — first run: F1

```
task: [smoke] node scripts/smoke.js
Error: Cannot find module '../experiments/pathfinder-Bot/node_modules/mineflayer'
    at Object.<anonymous> (D:\tmp\fresh-sim\scripts\smoke.js:6:20)
task: Failed to run task "smoke": exit status 1
```

### Unblocks + smoke pass

```
✔ Container fresh-sim-minecraft-1  Healthy  35.4s        (fresh volume, world-gen included)

npm ls mineflayer --prefix experiments/pathfinder-Bot
└── mineflayer@4.37.1                                    (lockfile held the pin — F5 evidence)

task smoke
[smoke] connecting to localhost:25565 (MC 1.21.6)...
[smoke] spawned OK
[smoke] PASS
```

### task up:all — full stack from scratch

```
✔ Image fresh-sim-event-service      Built   67.0s   (gradle bootJar BUILD SUCCESSFUL)
✔ Image fresh-sim-minecraft-service  Built   67.0s   (npm ci clean)
✔ Image fresh-sim-agent-service      Built   67.0s   (uv sync --frozen clean)
✔ Image fresh-sim-memory-service     Built   67.0s   (uv sync --frozen clean)
[+] up 15/15 — all containers Healthy (agent-service last, 169.3s)
```

### Verification (2026-07-23)

```
task seed                              → {"seeded":[],"existing":["Elara"]}
agent-service boot                     → "llm provider: ollama (warmed)"  model=llama3.1:8b
rcon-cli list                          → There are 1 of a max of 30 players online: Elara
tick loop                              → "tick complete" every ~60s, action=chat/move, error=false, 1.4–2.0s
ledger DecisionMade payload            → "llmProvider": "ollama", "tokensUsed": 970, "latencyMs": 1099,
                                         "decision": "chat {'message': "Lovely day for work, isn't it?"}"
teardown                               → 6 fresh-sim_* volumes removed; 6 ai-civilization-engine_* intact
restore                                → task up:all 10/10 healthy (gov + pov-rig in pre-sim exited states)
```

Full raw transcripts available in the session history if ever needed; nothing in
the elided output contradicts the summaries above.
