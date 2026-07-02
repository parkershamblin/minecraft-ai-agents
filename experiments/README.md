# experiments/ — archived proofs-of-concept

These predate the AI Civilization Engine monorepo. They are kept for history (and
Episode 0 b-roll), excluded from CI and workspaces, and never built.

## What each proved

| PoC | Proved |
|---|---|
| `lookAt-Bot/` | A Mineflayer bot connects to the local **vanilla 1.21.6** server (offline mode) and reacts to chat/entities |
| `pathfinder-Bot/` | `mineflayer-pathfinder` navigates the bot to a player on command (`come`) — the navigation primitive `minecraft-service` is built on |

## The empirically-proven version pin

These lockfile-resolved versions are the **only combination proven to work against
Minecraft 1.21.6 on this machine** — they are the source of the project's version
pin (see `docs/architecture/05-repository-devops.md` §3):

- `mineflayer` **4.37.1**
- `minecraft-data` **3.111.0** (transitive; do not pin independently)
- `mineflayer-pathfinder` **2.4.5**
- Minecraft server **1.21.6** (vanilla, `online-mode=false`, port 25565)

Upgrade rule: `MC_VERSION` and `mineflayer` move together in one atomic PR, gated
by `task smoke`.
