# Local Minecraft 26.2 profile

Compose / `.env.example` defaults stay on **1.21.6** (containerized Paper or
host vanilla on `:25565`). This runbook is the opt-in path to point
`minecraft-service` at a **host-run Minecraft Java 26.2** server using the
transplanted MineBot compat layer (`vendor/minecraft-data-26.2` + Prismarine
patches). No `configVersion` / skill-contract change — executor protocol only.

## `.env` knobs

```env
MC_VERSION=26.2
MC_HOST=host.docker.internal
MC_PORT=55916
```

Leave the compose `minecraft` (Paper) profile **off**. 26.2 is not the
containerized Paper pin; use the host vanilla server MineBot already runs
(typically under a `server_data_26_2` world tree with **Temurin 25**, not the
1.21.6 JVM/server jar).

Host-run `minecraft-service` (no Docker) can use `MC_HOST=127.0.0.1` instead.

## What the transplant provides

| Piece | Role |
|---|---|
| `vendor/minecraft-data-26.2/` | Protocol 776 data + wrapper over upstream 3.112.0 |
| `patches/*` (7 MineBot patches + nest trail fix) | Join/login/dig, chunks, physics, viewer, pvp tick rename, protodef noise |
| `vendor/prismarine-viewer-26.2-assets/` | Atlas/blockStates for POV (canvas is stubbed → noop2 here) |
| `scripts/prepare-prismarine-viewer-26.2.cjs` | postinstall installs viewer assets into `prismarine-viewer` |

**Not ported:** MineBot pathfinder patch, baritone, chunk_translator /
browser_viewer hybrid. Body join does not need those; POV tile correctness
for brand-new 26.2 blocks is a follow-up if cams look wrong.

## Smoke check

With the 26.2 server listening on `:55916`:

```powershell
$env:MINECRAFT_LIVE_TEST=1
# optional: $env:MINECRAFT_TEST_HOST='127.0.0.1'; $env:MINECRAFT_TEST_PORT='55916'
npm test --workspace @civ/minecraft-service -- test/minecraft26_2LiveSpawn.test.ts
```

Without the gate (or without a server), that test is skipped and the suite
stays green. Manual stack check: infra up → deploy minecraft-service with the
26.2 env → spawn one villager → ledger shows `VillagerSpawned` / no immediate
kick.
