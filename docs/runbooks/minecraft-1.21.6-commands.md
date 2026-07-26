# Runbook: Minecraft Java Edition 1.21.6 server commands (over RCON)

**When you need this:** you are about to send a server command at the live
world — staging a race, resetting between attempts, reading state back for a
preflight check, or debugging a bot that "dug" a block that never broke. It is
a reference, not a procedure: §7 is the part that is specific to this repo and
the part you will get wrong first.

**Why this version:** `MC_VERSION` is pinned to `1.21.6` in
`infrastructure/docker/docker-compose.yml:385`, and the containerized Paper
image is pinned to a full patch tag at `:377`. The live
minecraft.wiki documents a much newer game (26.x). Several command surfaces
have changed since 1.21.6 in ways that fail *silently* when copy-pasted — §1
is the list of those traps. Do not skip it.

**Edition:** Java Edition only. Bedrock-only commands and Bedrock-only argument
forms are excluded.

**Provenance:** assembled from minecraft.wiki (`/w/Commands`,
`/w/Java_Edition_1.21.6`, `/w/Target_selectors`, `/w/Command_context`,
`/w/Permission_level`, `/w/RCON`, `/w/Game_rule`, and the per-command
subpages under `/w/Commands/<name>`), then audited command-by-command against
the wiki for the twelve commands this project's benchmark machinery actually
depends on. §8 records what that audit changed and what it could not settle.
No retrieval timestamp was captured for the original assembly pass; the audit
pass ran 2026-07-25. Treat neither as a guarantee that the wiki has not moved
since.

---

## 1. Read this first: the wiki documents a newer version than 1.21.6

Three reworks landed **after** 1.21.6 and will silently break copy-pasted
syntax if you take the live wiki at face value.

| What changed | When | Consequence for 1.21.6 |
|---|---|---|
| **All game rules renamed** from camelCase to snake_case resource locations (`doDaylightCycle` → `advance_time`, `doWeatherCycle` → `advance_weather`, `doMobSpawning` → `spawn_mobs`, `keepInventory` → `keep_inventory`, `mobGriefing` → `mob_griefing`, `randomTickSpeed` → `random_tick_speed`, `doEntityDrops` → `entity_drops`, `doTileDrops` → `block_drops`, `doInsomnia` → `spawn_phantoms`) | **1.21.11 / snapshot 25w44a** ([Game rule](https://minecraft.wiki/w/Game_rule)) | In **1.21.6 you MUST use the camelCase names.** The snake_case names do not exist. |
| **`doFireTick` removed outright** in the same pass, replaced by `fire_spread_radius_around_player` | 1.21.11 / 25w44a | In 1.21.6 `doFireTick` is a normal boolean rule and the replacement does not exist. This is the sharpest proof that the wiki's *current* rule table is not 1.21.6's rule table. |
| **`/time` reworked onto "world clocks"** — `time of <clock> …`, `time of <clock> pause`/`resume`, and `time rate` | **26.1 snapshot 3** (`rate` in 26.1-pre1) ([/time](https://minecraft.wiki/w/Commands/time)) | In **1.21.6 only** `time set`, `time add`, `time query` exist, and `time query` takes `daytime\|gametime\|day` — **not** the `time query time` / `time query <timeline>` forms the current wiki shows. |
| `execute (if\|unless) stopwatch <id> <range>` | 1.21.11 / 25w41a | Not available in 1.21.6. |

Commands in the current wiki's master table that **did not exist in 1.21.6**,
and are therefore absent from §2:

| Command | Added in |
|---|---|
| `/fetchprofile` | 1.21.9 (25w34a) |
| `/stopwatch` | 1.21.11 (25w41a) |
| `/swing` | 26.1 snapshot 1 |
| `/unpublish` | 26.2 snapshot 8 |
| `/posteffect` | upcoming, JE 26.3 |

Commands and rules **added in 1.21.6 itself** (verified against the
[1.21.6 changelog](https://minecraft.wiki/w/Java_Edition_1.21.6); released
2025-06-17, data pack format 80, protocol 771): `/dialog`, `/waypoint`,
`/version`, `datapack create <id> <name>`, a `ui` sound category for
`/playsound` (which also renamed the `Friendly Creatures` / `Hostile Creatures`
categories to `Friendly Mobs` / `Hostile Mobs`), and the `locatorBar` game rule
(introduced 25w15a as `useLocatorBar`, renamed 25w17a; enabled by default on
servers).

---

## 2. Alphabetical command table — Java Edition 1.21.6

Op level is the permission level the sender must hold. The server console and
RCON run at level **4** (§6.1), so everything here is reachable over RCON
unless it is inherently client-side or singleplayer. Syntax shown is the
*minimal* useful form; the linked subpage carries the full overload set.

| Command | Minimal syntax | Op | Purpose |
|---|---|---|---|
| `/advancement` | `advancement (grant\|revoke) <targets> (everything\|only <adv>\|from <adv>\|through <adv>\|until <adv>)` | 2 | Give or remove player advancements. |
| `/attribute` | `attribute <target> <attribute> (get\|base get\|base set <v>\|modifier …)` | 2 | Query/add/remove/set an entity attribute. |
| `/ban` | `ban <targets> [<reason>]` | 3 | Add a player to the banlist. |
| `/ban-ip` | `ban-ip (<player>\|<address>) [<reason>]` | 3 | Add an IP address to the banlist. |
| `/banlist` | `banlist [ips\|players]` | 3 | Display the banlist. |
| `/bossbar` | `bossbar (add\|get\|list\|remove\|set) …` | 2 | Create and modify boss bars. |
| `/clear` | `clear [<targets>] [<item>] [<maxCount>]` | 2 | Clear items from player inventories. See §5.3 for what it does *not* touch. |
| `/clone` | `clone <begin> <end> <destination> [replace\|masked] [normal\|force\|move]` | 2 | Copy blocks from one region to another. |
| `/damage` | `damage <target> <amount> [<damageType>] …` | 2 | Apply damage to entities. |
| `/data` | `data (get\|merge\|modify\|remove) (block <pos>\|entity <t>\|storage <t>) …` | 2 | Get/merge/modify/remove NBT. Output is ellipsized — §6.3, §7.4. |
| `/datapack` | `datapack (list\|enable\|disable\|create <id> <name>)` | 2 | Control loaded data packs. `create` is new in 1.21.6. |
| `/debug` | `debug (start\|stop\|function <fn>)` | 3 | Start/stop a profiler session. |
| `/defaultgamemode` | `defaultgamemode <mode>` | 2 | Set the default game mode for joining players. |
| `/deop` | `deop <targets>` | 3 | Revoke operator status. |
| `/dialog` | `dialog show <targets> <dialog>` / `dialog clear <targets>` | 2 | **New in 1.21.6.** Show/clear a data-pack-defined dialog on clients. |
| `/difficulty` | `difficulty [peaceful\|easy\|normal\|hard]` | 2 | Set or query difficulty. **String ids only** — see §5.7. |
| `/effect` | `effect give <targets> <effect> [<seconds>\|infinite] [<amplifier>] [<hideParticles>]` / `effect clear [<targets>] [<effect>]` | 2 | Add or remove status effects. |
| `/enchant` | `enchant <targets> <enchantment> [<level>]` | 2 | Enchant the held item. |
| `/execute` | `execute <subcommand…> run <command>` | 2 | Run a command with a modified context. §4. |
| `/experience` | `experience (add\|set) <targets> <amount> [levels\|points]` / `experience query <targets> (levels\|points)` | 2 | Alias of `/xp`. |
| `/fill` | `fill <from> <to> <block> [replace\|destroy\|hollow\|keep\|outline]` | 2 | Fill a region with a block. |
| `/fillbiome` | `fillbiome <from> <to> <biome> [replace <filter>]` | 2 | Fill a region with a biome. |
| `/forceload` | `forceload add <from> [<to>]` / `forceload remove <from> [<to>]` / `forceload remove all` / `forceload query [<pos>]` | 2 | Keep chunks loaded. Block coords, max 256 chunks per command. §5.8. |
| `/function` | `function <name> [<args>]` | 2 | Run a data-pack function. |
| `/gamemode` | `gamemode <survival\|creative\|adventure\|spectator> [<target>]` | 2 | Set a player's game mode. |
| `/gamerule` | `gamerule <rule name> [<value>]` | 2 | Set or query a game rule. **camelCase names in 1.21.6.** |
| `/give` | `give <targets> <item>[<components>] [<count>]` | 2 | Give an item. Component syntax since 1.20.5. |
| `/help` | `help [<command>]` | 0 | List commands / show usage. |
| `/item` | `item replace (block <pos>\|entity <targets>) <slot> with <item> [<count>]` / `item modify … <modifier>` | 2 | Manipulate specific inventory slots. |
| `/jfr` | `jfr (start\|stop)` | 4 | Java Flight Recorder profiling. |
| `/kick` | `kick <targets> [<reason>]` | 3 | Kick a player. |
| `/kill` | `kill [<targets>]` | 2 | Kill entities. Over RCON the target is **not** optional — §5.4. |
| `/list` | `list [uuids]` | 0 | List online players. Used as the fleet-readiness gate in `scripts/race-rb2.mjs:164`. |
| `/locate` | `locate (structure\|biome\|poi) <id>` | 2 | Locate the nearest structure/biome/POI. |
| `/loot` | `loot (give\|insert\|replace\|spawn) … (fish\|loot\|kill\|mine) …` | 2 | Drop/insert items from a loot table. |
| `/me` | `me <action>` | 0 | Emote from the sender. |
| `/msg` | `msg <targets> <message>` | 0 | Alias of `/tell`, `/w`. |
| `/op` | `op <targets>` | 3 | Grant operator status. |
| `/pardon` | `pardon <targets>` | 3 | Remove a player from the banlist. |
| `/pardon-ip` | `pardon-ip <address>` | 3 | Remove an IP from the banlist. |
| `/particle` | `particle <name> [<pos>] …` | 2 | Create particles. |
| `/perf` | `perf (start\|stop)` | 4 | Capture 10 s of performance metrics. |
| `/place` | `place (feature\|jigsaw\|structure\|template) <id> [<pos>]` | 2 | Place a configured feature, jigsaw, or structure. |
| `/playsound` | `playsound <sound> <source> <targets> [<pos>] [<volume>] [<pitch>] [<minVolume>]` | 2 | Play a sound. `ui` source added in 1.21.6. |
| `/publish` | `publish [<allowCommands>] [<gamemode>] [<port>]` | 4 | Open a singleplayer world to LAN. **Meaningless on a dedicated server.** |
| `/random` | `random (value\|roll) <range> [<sequence>]` / `random reset …` | 0 (value/roll), 2 (reset) | Draw a random value / control a random sequence. |
| `/recipe` | `recipe (give\|take) <targets> (*\|<recipe>)` | 2 | Give or take recipe unlocks. |
| `/reload` | `reload` | 2 | Reload data packs. |
| `/return` | `return <value>` / `return run <command>` / `return fail` | 2 | Control function execution flow. |
| `/ride` | `ride <target> (mount <vehicle>\|dismount)` | 2 | Make entities start/stop riding. |
| `/rotate` | `rotate <target> <rotation>` / `rotate <target> facing (<pos>\|entity <e> [<anchor>])` | 2 | Change an entity's rotation. Added 1.21.2 (24w40a). |
| `/save-all` | `save-all [flush]` | 4 | Save the server to disk. §5.9. |
| `/save-off` | `save-off` | 4 | Disable level-file writes (for filesystem backups). |
| `/save-on` | `save-on` | 4 | Re-enable level-file writes. |
| `/say` | `say <message>` | 2 | Broadcast a message. |
| `/schedule` | `schedule function <fn> <time> [append\|replace]` / `schedule clear <fn>` | 2 | Delay a function. Keyed off `gametime` — survives every reset. |
| `/scoreboard` | `scoreboard objectives …` / `scoreboard players …` | 2 | Manage objectives and scores. |
| `/seed` | `seed` | 0 (singleplayer) / 2 (server) | Display the world seed. |
| `/setblock` | `setblock <pos> <block> [destroy\|keep\|replace]` | 2 | Change one block. |
| `/setidletimeout` | `setidletimeout <minutes>` | 3 | Minutes before idle players are kicked. |
| `/setworldspawn` | `setworldspawn [<pos>] [<angle>]` | 2 | Set the world spawn. **Overworld only in 1.21.6** — §5.5. |
| `/spawnpoint` | `spawnpoint [<targets>] [<pos>] [<angle>]` | 2 | Set a player's individual spawn point. |
| `/spectate` | `spectate [<target>] [<player>]` | 2 | Make a spectator spectate an entity. |
| `/spreadplayers` | `spreadplayers <center> <spreadDistance> <maxRange> [under <maxHeight>] <respectTeams> <targets>` | 2 | Scatter entities to random legal surface locations. |
| `/stop` | `stop` | 4 | Stop the server (saves on shutdown). |
| `/stopsound` | `stopsound <targets> [<source>] [<sound>]` | 2 | Stop a playing sound. |
| `/summon` | `summon <entity> [<pos>] [<nbt>]` | 2 | Summon an entity. |
| `/tag` | `tag <targets> (add\|remove) <name>` / `tag <targets> list` | 2 | Manage entity tags. |
| `/team` | `team (list\|add\|remove\|empty\|join\|leave\|modify) …` | 2 | Manage teams. |
| `/teammsg` | `teammsg <message>` | 0 | Alias of `/tm`. |
| `/teleport` | `teleport [<targets>] (<location>\|<destination>) [<rotation>\|facing …]` | 2 | Alias of `/tp`. §5.5. |
| `/tell` | `tell <targets> <message>` | 0 | Alias of `/msg`, `/w`. |
| `/tellraw` | `tellraw <targets> <component>` | 2 | Send a JSON text component. |
| `/test` | `test …` | 2 | GameTest management. **UNVERIFIED on a vanilla 1.21.6 dedicated server** — §8.2. |
| `/tick` | `tick (query\|rate <rate>\|freeze\|unfreeze\|step [<time>]\|step stop\|sprint <time>\|sprint stop)` | 3 | Control tick rate / freeze ticking. Added 1.20.3 (23w43a). §5.7. |
| `/time` | `time set (<value>\|day\|noon\|night\|midnight)` / `time add <value>` / `time query (daytime\|gametime\|day)` | 2 | Change or query world time. **No `pause`/`resume`/`of <clock>`/`rate` in 1.21.6.** |
| `/title` | `title <targets> (title\|subtitle\|actionbar) <component>` / `title <targets> (clear\|reset\|times …)` | 2 | Manage screen titles. |
| `/tm` | `tm <message>` | 0 | Alias of `/teammsg`. |
| `/tp` | `tp [<targets>] <location\|destination>` | 2 | Alias of `/teleport`. |
| `/transfer` | `transfer <hostname> [<port>] [<players>]` | 3 | Transfer players to another server. Added 1.20.5. |
| `/trigger` | `trigger <objective> [add <v>\|set <v>]` | 0 | Let non-op players fire a scoreboard trigger. |
| `/version` | `version` | operator (**level UNVERIFIED** — §8.2) | **New in 1.21.6.** Print server version, protocol, and pack formats. |
| `/w` | `w <targets> <message>` | 0 | Alias of `/tell`, `/msg`. |
| `/waypoint` | `waypoint list` / `waypoint modify <entity> (color <c>\|style set <s>)` | 2 | **New in 1.21.6.** Query/modify Locator Bar waypoints. |
| `/weather` | `weather (clear\|rain\|thunder) [<duration>]` | 2 | Set the weather. §5.2. |
| `/whitelist` | `whitelist (on\|off\|list\|add\|remove\|reload)` | 3 | Manage the whitelist. |
| `/worldborder` | `worldborder (add\|set) <distance> [<time>]` / `center <pos>` / `damage (amount\|buffer) <v>` / `get` / `warning (distance\|time) <v>` | 2 | Manage the world border. Default size 59,999,968. |
| `/xp` | `xp (add\|set) <targets> <amount> [levels\|points]` | 2 | Alias of `/experience`. |

Older removals (`/replaceitem` → `/item` in 1.17, `/locatebiome` →
`/locate biome` in 1.19) are already absent from the 1.21.6 command set.

---

## 3. Target selectors

### 3.1 Selector variables

| Selector | Selects | Added |
|---|---|---|
| `@p` | Nearest **player** | 1.4.2 (12w32a) |
| `@r` | Random online **player** | 1.4.2 (12w32a) |
| `@a` | **All** online players — read §7.3 before you use this | 1.4.2 (12w32a) |
| `@e` | All **entities** | 1.8 (14w02a) |
| `@s` | The executing **entity** — selects nothing over RCON | 1.12 (17w16b) |
| `@n` | Nearest **entity** | 1.21 (24w21a); present in 1.21.6 |

Default sort/limit: `@p` → `sort=nearest,limit=1`; `@r` → `sort=random,limit=1`;
`@s` → the executor only; `@a`/`@e` → `sort=arbitrary`; `@n` behaves as
nearest, limit 1.

### 3.2 Selector arguments

Syntax is `@<var>[arg=value,arg=value,…]`. Ranges take `min..max`, `..max`,
`min..`, or a bare value.

| Argument | Form / example | Notes |
|---|---|---|
| `x`, `y`, `z` | `@e[x=100,y=64,z=-40]` | Sets the reference point for distance/volume. Java does not center-correct. |
| `distance` | `@e[distance=..8]`, `distance=8..16`, `distance=10` | Java-only float range; unsigned only. |
| `dx`, `dy`, `dz` | `@e[x=0,y=64,z=0,dx=16,dy=4,dz=16]` | Cuboid from (x,y,z) to (x+dx, y+dy, z+dz); signed and fractional allowed; minimum 1 block per axis. |
| `scores` | `@a[scores={kills=1..,deaths=0}]` | Integer ranges per objective. |
| `tag` | `tag=mytag`, `tag=!mytag`, `tag=` (no tags), `tag=!` (has at least one) | Repeatable. |
| `team` | `team=red`, `team=!red`, `team=` (teamless), `team=!` (on any team) | Since 1.21.5 (25w05a) `team` can select non-living entities. |
| `limit` | `@e[limit=1]` | Cap on results. |
| `sort` | `sort=nearest\|furthest\|random\|arbitrary` | Combine with `limit`. |
| `level` | `@a[level=30..]` | Players only; integer range. |
| `gamemode` | `gamemode=survival`, `gamemode=!spectator` | Players only; negation repeatable. |
| `name` | `name=Alex`, `name="Two Words"`, `name=!Alex` | Quotes required for spaces. |
| `x_rotation` | `x_rotation=-90..0` | Pitch: -90 (up) … 0 (horizon) … +90 (down). |
| `y_rotation` | `y_rotation=-90..0` | Yaw: south 0, east -90, north ±180, west +90. |
| `type` | `type=item`, `type=minecraft:creeper`, `type=!player`, `type=#minecraft:skeletons` | **Not usable with `@a`, `@p`, `@r`.** Only negated forms may repeat. |
| `nbt` | `nbt={OnGround:true}`, `nbt=!{…}` | SNBT; repeatable, all must match. |
| `advancements` | `advancements={story/smelt_iron=true}` | Players only. |
| `predicate` | `predicate=mypack:my_predicate`, `predicate=!…` | Repeatable. |

Idioms used by this project's scripts:

```
@e[type=item]                       every dropped item entity in loaded chunks
@e[type=item,distance=..64]         dropped items near the execution position
@e[type=!player]                    every non-player entity
@e[type=zombie]                     one hostile species (race-rb2.mjs sweeps a list of 16)
```

The namespace is optional: `kill @e[type=zombie]`
(`scripts/race-rb2.mjs:142`) and `kill @e[type=minecraft:zombie]`
(`scripts/drill-rb1.mjs:144`) are the same command. Both spellings are live in
this repo.

---

## 4. `/execute` context modifiers

Op level 2. Chain modifiers, terminate with `run <command>`.

Modifiers: `align <axes>`, `anchored (eyes|feet)`, `as <targets>`,
`at <targets>`, `facing <pos>` / `facing entity <targets> <anchor>`,
`in <dimension>`, `on <relation>`, `positioned <pos>` /
`positioned as <targets>` / `positioned over <heightmap>`, `rotated <rot>` /
`rotated as <targets>`, `summon <entity>`.

Conditions: `(if|unless)` plus `biome <pos> <biome>`, `block <pos> <block>`,
`blocks <start> <end> <dest> (all|masked)`, `data (block|entity|storage) … <path>`,
`dimension <dim>`, `entity <entities>`, `function <fn>`,
`items (block|entity) … <slots> <predicate>`, `loaded <pos>`,
`predicate <predicate>`, `score <t> <obj> (<|<=|=|>=|>) <src> <obj>` or
`score <t> <obj> matches <range>`.

Store: `store (result|success) (block|bossbar|entity|score|storage) …` — must
precede `run`.

`execute if stopwatch …` is 1.21.11, not 1.21.6.

Worked example from this repo — re-anchoring a `locate` away from the console's
world-spawn origin (`scripts/race-rb2.mjs:198`):

```
execute positioned <x> 100 <z> run locate biome #minecraft:is_forest
```

---

## 5. Reset and staging toolkit

Everything below is written **as sent over RCON** (no leading `/`) and is the
1.21.6 form. Ordering matters: game rules before time/weather, save last.

### 5.1 Freeze the world clock and set a fixed time

```
gamerule doDaylightCycle false
time set 6000
time query daytime
```

- `time set` takes a raw tick value or a marker: `day` = 1000, `noon` = 6000,
  `night` = 13000, `midnight` = 18000. `noon` gives full daylight with no
  spawn-darkness.
- `time query` takes `daytime` (0–23999 within the day), `gametime` (total
  ticks since world creation), or `day` (day number). The `time query time` /
  `time query <timeline>` forms on the live wiki are the 26.1 rework — they do
  not parse in 1.21.6.
- Freezing daylight does **not** stop mob spawning, random block ticks,
  hunger, or crop growth.
- To stop *all* ticking, use `tick freeze` (§5.7) — `time pause` does not exist
  in 1.21.6.

### 5.2 Clear and freeze weather

```
gamerule doWeatherCycle false
weather clear 1000000t
```

- `weather (clear|rain|thunder) [<duration>]`. Duration units: `t` = ticks
  (default, omittable), `s` = 20 ticks, `d` = 24000 ticks. Argument became a
  time type in 22w03a (1.19.4); before that it was a bare integer.
- Omitting the duration picks a random value in the per-type band: clear
  12000–180000 ticks, rain 12000–24000, thunder 3600–15600. **Pass an explicit
  duration** if you want a repeatable attempt — the default is random.
- Works in non-Overworld dimensions since 1.20.5 (24w11a).
- Does **not** undo lightning damage, burning blocks, or wet entity state.

### 5.3 Clear player inventories and XP

```
clear <player>
xp set <player> 0 levels
xp set <player> 0 points
effect clear <player>
```

(Deliberately not `@a` — see §7.3.)

- `clear [<targets>] [<item>] [<maxCount>]`, all arguments optional. It clears
  the main inventory and hotbar, the offhand slot (since 1.9), the four
  crafting-grid slots (since 1.16), and any item held by the cursor.
- It does **not** clear **armor slots** or the **ender chest**. If either
  matters, be explicit:
  `item replace entity <player> armor.head with air` (and `chest`, `legs`,
  `feet`), `item replace entity <player> enderchest.<0..26> with air`.
- `<maxCount>` of `0` turns the command into a **query**: it counts matching
  items and clears nothing. Useful as a preflight assertion.
- `<item>` uses the 1.20.5+ item-predicate form `item_id[tests]`, e.g.
  `clear <player> minecraft:coal`.
- Deterministic loadout instead of "empty":
  `item replace entity <player> weapon.mainhand with minecraft:iron_pickaxe`.
  Slot names: `weapon.mainhand`, `weapon.offhand`,
  `armor.head|chest|legs|feet`, `hotbar.0`–`hotbar.8`,
  `inventory.0`–`inventory.26`, `container.N`, `enderchest.N`.

### 5.4 Remove dropped item entities and other litter

```
kill @e[type=item]
kill @e[type=experience_orb]
kill @e[type=arrow]
```

- `kill [<targets>]` defaults to the executor. Over RCON there is **no executor
  entity**, so a bare `kill` reports "Failed" rather than doing something
  catastrophic — but never lean on that. Always pass an explicit selector.
- Selectors only reach **loaded chunks**. Items your bots dropped in chunks
  that have since unloaded survive `kill @e[type=item]` entirely. Force-load
  the arena first (§5.8) or run the sweep while the fleet is still standing in
  it.
- Scoped variant, so a cleanup at a far post does not sweep the other team's
  arena: `execute positioned <x> <y> <z> run kill @e[type=item,distance=..128]`.

### 5.5 Teleport, spawn point, world spawn

```
tp <player> <x> <y> <z> <yaw> <pitch>
spawnpoint <player> <x> <y> <z> <yaw>
setworldspawn <x> <y> <z> <yaw>
```

- `<rotation>` is `<yaw> <pitch>`: yaw -180.0 (north) … 0 (south) … 179.9;
  pitch -90.0 (up) … 90.0 (down). Other overloads:
  `teleport <targets> <destination-entity>`,
  `teleport <targets> <location> facing <pos>`,
  `teleport <targets> <location> facing entity <entity> [eyes|feet]`.
- **Relative coordinates resolve against the command's executor, not the
  target.** Over RCON the executor is the console, anchored at world spawn
  (§6.2) — so use absolute coordinates, or re-anchor explicitly with
  `execute at <player> run …` / `execute positioned <x> <y> <z> run …`.
- `spawnpoint [<targets>] [<pos>] [<angle>]` — per-player respawn point; the
  `angle` (yaw) argument arrived in 1.16.2 (20w29a), and it has worked in any
  dimension since 1.16 (20w12a). **The optional `pitch` argument is 1.21.9
  Pre-Release 1 — it does not exist in 1.21.6.**
- `setworldspawn [<pos>] [<angle>]` — the world's default spawn. Since 1.20.5
  (24w03a) it **succeeds only in the Overworld**; non-Overworld support and the
  optional `pitch` argument both landed in **1.21.9 Pre-Release 1 (25w31a)**,
  so on 1.21.6 use the two-argument `setworldspawn <pos> <angle>` form and stay
  in the Overworld.
- Teleporting does not clear riding state — `ride <target> dismount` first if
  that matters — and passing only coordinates leaves the target's dimension
  alone; wrap with `execute in minecraft:overworld run tp …` to be explicit.
- A teleport does not cancel an in-flight pathfinder goal. This bit a race
  take: bots walked 150 blocks back off their post after a clean `tp`. The
  repo's answer (`scripts/race-rb2.mjs:220-268`) is
  `spreadplayers` → verify position → `spawnpoint` at the verified spot →
  `clear` → `kill`, so the lossless respawn resets every in-flight goal at the
  post.

### 5.6 Game rules for a repeatable pre-attempt state (1.21.6 camelCase)

```
gamerule doDaylightCycle false
gamerule doWeatherCycle false
gamerule doMobSpawning false
gamerule doFireTick false
gamerule keepInventory true
gamerule randomTickSpeed 0
gamerule mobGriefing false
gamerule doEntityDrops true
gamerule doTileDrops true
```

| Rule | Default | Type | Effect |
|---|---|---|---|
| `doDaylightCycle` | `true` | bool | Advance the day/night clock. |
| `doWeatherCycle` | `true` | bool | Advance weather. |
| `doMobSpawning` | `true` | bool | Natural mob spawning. |
| `doFireTick` | `true` | bool | Fire spreads and burns out. |
| `keepInventory` | `false` | bool | Keep items and XP on death. |
| `randomTickSpeed` | `3` | int | Random block ticks per chunk section per tick (crop growth, leaf decay, fire spread, ice melt). `0` freezes all of it. |
| `mobGriefing` | `true` | bool | Mobs change blocks (creeper craters, enderman pickups, villager farming). |
| `doEntityDrops` | `true` | bool | Entity/vehicle drops. |
| `doTileDrops` | `true` | bool | Block drops when broken. **`false` means mining yields nothing — for a gathering benchmark this must stay `true`.** |
| `doInsomnia` | `true` | bool | Phantom spawning. |
| `locatorBar` | enabled on servers | bool | New in 1.21.6. Player locator bar. |

Also present in 1.21.6 and occasionally relevant: `sendCommandFeedback`,
`commandBlockOutput`, `logAdminCommands`, `doImmediateRespawn`, `spawnRadius`,
`naturalRegeneration`, `fallDamage`, `maxEntityCramming`, `disableRaids`.
**UNVERIFIED:** their exact 1.21.6 defaults were not confirmed — query each
live with `gamerule <name>` before relying on it.

- `/gamerule` does **not** retroact: mobs already spawned stay
  (`kill @e[type=!player]`), fires already burning keep burning, crops already
  grown stay grown.
- **Query form is the assertion.** `gamerule doDaylightCycle` with no value
  prints the current value. This repo sets *then reads back* every rule it
  cares about, because `level.dat` can override assumptions —
  `scripts/race-rb2.mjs:121-127`.

### 5.7 Difficulty and tick control

```
difficulty peaceful
tick query
tick freeze
tick unfreeze
tick rate 20.0
```

- `difficulty [peaceful|easy|normal|hard]`; no argument queries. **Java Edition
  1.13 (17w45a) removed shorthand and numeric ids** — `difficulty e` and
  `difficulty 1` are errors in 1.21.6. String ids only.
- Vanilla: "on a multiplayer server difficulty lasts only until the server is
  restarted — on restart, difficulty is reloaded from `server.properties`."
  Paper is different and worse; see §7.4.
- `tick freeze` halts **all gameplay ticking except players and any entity a
  player is riding**. `tick step [<time>]` advances N ticks while frozen
  (`<time>` optional since 23w44a, defaults to 1), `tick step stop` aborts a
  step, `tick sprint <time>` fast-forwards, `tick sprint stop` aborts a sprint.
  `tick rate <rate>` takes 1.0–10000.0 TPS, default 20.0. Op level **3**.
  Cannot be run from a command block.
- Whether `tick freeze` affects chunk loading is **UNVERIFIED** — the wiki says
  only "all gameplay elements".

### 5.8 Chunk residency

```
forceload add -128 -128 128 128
forceload query
forceload remove all
```

- `forceload add <from> [<to>]` takes **block** coordinates that resolve to
  chunks, and fails outright if the region covers more than **256 chunks**.
  Force-loaded chunks persist across restarts until removed.
- Needed because every selector (`kill @e[type=item]`, `@e[type=!player]`,
  position reads) only sees loaded chunks.
- **Force-loading is not inert.** Since 1.21.5, forceloaded chunks receive
  random ticks and crops grow in them without a nearby player. If you
  force-load an arena and then leave it force-loaded between attempts, the
  world keeps changing while nobody is there. Pair `forceload add` with
  `randomTickSpeed 0`, or `forceload remove all` when the sweep is done.

### 5.9 Save

```
save-all flush
```

- Plain `save-all` writes players immediately and queues chunks for gradual
  saving. **`save-all flush` writes players and chunks immediately, freezing
  the server briefly** — this is the one to use before snapshotting or copying
  the world directory. Both are op level 4, as are `save-off` / `save-on`.
- `save-all` persists nothing conceptually new; the trap is the inverse.
  In-memory state (difficulty, game rules, world spawn, time) is lost if the
  container is killed inside its stop window without a save. This repo's race
  preflight does `difficulty <x>` → `save-all` → read back
  (`scripts/race-rb2.mjs:148-152`) for exactly this reason.

### 5.10 What a reset does NOT restore

Run every command in §5 and the world is still not the world you started with.
These survive, and every one of them is a confound on a repeated benchmark:

- **Mined ore and felled trees.** The blocks are gone. Nothing in §5 brings
  them back; only a fresh world directory, a `/clone` from a pristine template
  region, or a `/fill` does.
- **Placed blocks** — crafting tables, furnaces, chests, torches, dirt towers,
  and any creeper crater. Same remedy.
- **`gametime`.** It is monotonic and cannot be rewound by `time set`.
  Anything keyed off it — `/schedule`, `minecraft.custom:play_time`, tick-diff
  timers — carries across every attempt.
- **Chunk-generation state.** Chunks generated during attempt 1 are already on
  disk for attempt 2. Attempt 1 pays the world-gen cost and nobody else does:
  a real, order-dependent per-run timing confound on any first-visit
  benchmark. This is the same class of bias as the blocked-run-order wear
  confound documented in `bench/results/RACE_REPORT.md`.
- **Scoreboard objectives and scores**, including anything a dashboard or
  harness has been accumulating.
- **Statistics** (blocks mined, distance walked, deaths) and **advancements** /
  recipe unlocks. `/advancement revoke <targets> everything` handles the second
  pair; statistics have no command.
- **Villager POI claims** — a villager that has bound to a workstation or bed
  keeps that binding, and the POI remains claimed.
- **Container contents** (chests, furnaces, barrels), **item frames**, and
  **armor stands**.
- **Ender chest contents** — `/clear` does not touch them (§5.3).
- **Entity identity and mob memory** — anything not killed keeps its UUID,
  pathfinding state, anger, and target memory.

If the attempt-to-attempt delta matters more than absolute numbers, reset the
world directory. If it does not, at minimum record which of the above you did
not control, in the report.

---

## 6. Gotchas: running these over RCON

### 6.1 There is no `@s`, and no executing entity

Documented console context
([Command context](https://minecraft.wiki/w/Command_context)):

- Permission level: **4**
- Executor name: **`Server`**
- Executor entity: **None**
- Dimension: **Overworld**
- Position: **bottom north-west corner of the block at world spawn**
- Rotation: **`(0, 0)`**
- Anchor: **Feet**

Consequences:

- `@s` selects **nothing**. Any command using it errors or affects zero
  entities. Use an explicit name, `@e`, or `execute as <player> run …`.
- Commands whose target defaults to the executor (`kill`, `clear`,
  `spawnpoint`, `setworldspawn`, `effect clear`, `gamemode`) have **no sensible
  default** over RCON. Always pass targets and positions.
- `@p` and `@n` resolve from **world spawn**, not from any player. `@p` over
  RCON means "player nearest world spawn", which mid-race is almost never who
  you meant.

### 6.2 `~` and `^` resolve against world spawn, rotation (0,0)

- `~ ~ ~` from RCON is the block at **world spawn**, not a player.
- `^ ^ ^` uses rotation `(0, 0)` — facing **south**, feet anchor. `^ ^ ^5` is
  "5 blocks south of world spawn".
- Local (`^`) and world (`~`/absolute) coordinates **cannot be mixed** in one
  triple; `^ 0 ^` is an error.
- Rule for any harness: **absolute coordinates**, or an explicit
  `execute positioned …` / `execute at <player>` re-anchor.

### 6.3 Output is truncated and hard to parse

- RCON packet limits: client→server payload max **1446 bytes**; server→client
  max **4096 bytes** (4110 total). Long responses **fragment across packets**
  and there is no simple way to know when the last one has arrived.
- Many commands return nothing, and **there is no way to detect an unknown
  command**. A typo and a successful silent command look identical over RCON.
  Verify by reading state back (`gamerule <name>`, `time query daytime`,
  `difficulty`, `data get …`) rather than by trusting an empty reply. Every
  preflight check in `scripts/race-rb2.mjs` is built this way.
- Section-sign colour codes arrive as byte `0xA7` and break strict-ASCII
  clients.

### 6.4 Permission levels

| Level | Name | Unlocks |
|---|---|---|
| 0 | — | Base commands (`/help`, `/list`, `/me`, `/msg`, `/tell`, `/w`, `/teammsg`, `/tm`, `/trigger`). |
| 1 | Moderator | Bypass spawn protection. |
| 2 | Gamemaster | Most world/entity commands, command blocks, difficulty, target selectors. |
| 3 | Admin | Multiplayer management (`/ban`, `/kick`, `/op`, `/whitelist`, `/tick`, `/transfer`, `/setidletimeout`, `/debug`). |
| 4 | Owner | Everything, including `/stop`, `/save-*`, `/jfr`, `/perf`, `/publish`. |

The console and RCON run at **level 4**, so nothing in §5 is permission-blocked.
Two caveats:

- `op-permission-level` in `server.properties` caps what *opped players* get;
  it does not lower the console. If you delegate reset commands to an opped bot
  account instead of RCON, that account needs level 4 for `save-all` and level
  3 for `tick`.
- Level 1 bypasses spawn protection — which is exactly the mechanism behind the
  ghost-dig failure in §7.4.

---

## 7. This project's server (sourced from the repo, not the wiki)

### 7.1 The working invocation on this machine

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "<the whole command>"
```

Three things make this work, and each one is a way to get it wrong:

- **The container name is derived, not hardcoded.**
  `scripts/lib/containers.mjs:5-7` builds it as
  `${COMPOSE_PROJECT_NAME ?? 'ai-civilization-engine'}-${service}-${index}`, so
  the Paper container is `ai-civilization-engine-minecraft-1` on the default
  stack and something else entirely under an isolated
  `COMPOSE_PROJECT_NAME` (a fresh-install sim, a parallel world). Scripts must
  call `containerName('minecraft')`; only humans should type the literal.
- **`rcon-cli` takes no connection arguments.** It reads `RCON_PORT` and
  `RCON_PASSWORD` from the image's own environment
  (`infrastructure/docker/docker-compose.yml:408-411`). Do not pass `--host`,
  `--port`, or `--password`; there is nothing to pass them to.
- **The whole Minecraft command is ONE argv element.** Quote it as a single
  string. `rcon-cli gamerule keepInventory true` and
  `rcon-cli "gamerule keepInventory true"` are not the same call, and the
  scripts get this right by construction — see §7.2.

RCON port **25575 is not published to the host**. The Paper service publishes
only `25565:25565` (`infrastructure/docker/docker-compose.yml:412`), and the
services reach RCON compose-internally at `RCON_HOST=minecraft`
(`:162-164`, `:210-212`). There is no host-side RCON client to fall back on:
`docker exec` is the path.

### 7.2 The four scripts that issue server commands today

Each defines its **own** local `rcon()` helper. There is no shared wrapper —
if you change the invocation, change it in four places.

| Script | Line | Purpose |
|---|---|---|
| `scripts/race-rb2.mjs` | 57 | RB-2 race launcher: preflight, gamerules, difficulty, stationing. |
| `scripts/drill-rb1.mjs` | 33 | RB-1 single-villager drill: builds a staged pad, sets ores, gives tools. |
| `scripts/drill-rb2.mjs` | 40 | RB-2 dense-arena drill. |
| `scripts/spawn-teams.mjs` | 70 | Team spawn: `tp` + `spawnpoint` per bot after publishing spawn commands. |

All four are the same two lines:

```js
const rcon = (cmd) =>
  execFileSync('docker', ['exec', containerName('minecraft'), 'rcon-cli', cmd], { encoding: 'utf8' }).trim()
```

`execFileSync` with an argv array — not `execSync` with a shell string — is
what keeps the command a single argv element and keeps a player name out of a
shell. Interpolated names are still worth guarding:
`services/minecraft-service/src/world/humanInventory.ts:15` validates
`^[A-Za-z0-9_]{1,16}$` before building a `data get` string for exactly this
reason.

### 7.3 Do not use `@a` on this server

**`@a` is thirteen players, and three of the four kinds are not what you
meant.** A typical race has:

- **6 racers** — the ticked fleet
  (`services/minecraft-service/src/config.ts:47` defaults `POV_ROSTER` to
  `Elara,Bram,Wren,Ansel,Petra,Fen`; `scripts/race-rb2.mjs:117` requires
  `VILLAGER_COUNT >= 6`).
- **6 spectator cam bots** `pov_cam_1` … `pov_cam_6`
  (`services/minecraft-service/src/pov/roster.ts:33`, count from
  `config.ts:42`, `POV_VIEWER_COUNT` default 6). They are held in spectator
  mode on purpose — a survival cam body would interfere with the race.
- **the human operator**, `ParkerShamblin`, who is an op on this server
  (`infrastructure/docker/docker-compose.yml:402`) and is usually online
  spectating during a take.

So `gamemode survival @a` puts the camera crew into the race and yanks the
operator out of spectator. `clear @a` empties the operator's inventory.
`kill @a` kills the camera crew mid-shot. `tp @a` teleports all thirteen.

**The repo already refuses `@a` and says why**, at
`scripts/race-rb2.mjs:175-181`:

> Gamemode is enforced, then VERIFIED, roster-only (never `@a` — the operator's
> own player may be online spectating). A racer silently in creative would fake
> an honest-race win (instant mining, no hunger, no mob threat); a spectator
> reads as a stalled bot.

**The established pattern is a roster-scoped loop**: iterate the villager list
and issue one command per `minecraftUsername`, then read the result back. See
`scripts/race-rb2.mjs:181-188` (gamemode enforce + `data get … playerGameType`
verify) and `scripts/race-rb2.mjs:256-258` (`spawnpoint` / `clear` / `kill`,
per member, inside the stationing loop). Follow it. If you genuinely want every
player, spell out why in a comment next to the call.

The one selector that *is* safe broadly is entity-typed and player-free:
`kill @e[type=item]`, `kill @e[type=zombie]`. Those cannot touch a player.

### 7.4 Project gotchas that belong next to a command

**`data get` is ellipsized server-side past ~150 characters.** Measured live
2026-07-09; the response contains a literal `...` mid-SNBT, so a
full-inventory read is impossible. Read per slot instead —
`Inventory[i].id` and `Inventory[i].count` are single-value responses that can
never hit the cap and need no SNBT parsing
(`services/minecraft-service/src/world/humanInventory.ts:1-7`).

**The `Inventory` NBT is a dense list that reindexes**, and each RCON command
lands on a separate server tick — so a single per-slot pass can tear (miss a
stack, or pair slot *i*'s id with the next stack's count), and a torn read that
"loses" a stack for one cycle books its reappearance as a phantom haul. **Scan
twice and accept only two identical passes**:
`fetchHumanInventoryStable` at
`services/minecraft-service/src/world/humanInventory.ts:36-45` does exactly
that, and a discarded cycle costs nothing because deltas compare against the
last *accepted* scan. `MAX_SLOTS` is 41 (36 main + 4 armor + offhand),
`humanInventory.ts:18`; the probe stops at `Found no elements`
(`humanInventory.ts:20`).

**Paper persists difficulty per-world in `level.dat`, which overrides
`server.properties` on boot for existing worlds.** The vanilla wiki's rule
("difficulty reloads from `server.properties` on restart", §5.7) is therefore
wrong for this stack. The `DIFFICULTY: easy` env at
`infrastructure/docker/docker-compose.yml:393` seeds **new worlds only** — the
live world's difficulty lives in `level.dat` and is changed via RCON. And an
RCON `difficulty` change is in-memory until a world save, so the container's
10-second stop window can silently discard it. The closed loop is set →
`save-all` → read back, which is what `scripts/race-rb2.mjs:148-152` does.

**Spawn protection silently ghost-digs.** Paper's `spawn-protection` (vanilla
default 16) rejects block breaks by non-op players within 16 blocks of world
spawn: the bot's client believes the block broke, the server keeps it, and the
dig "completes" with zero yield. It cost two RB-1 drill runs. The compose
profile bakes `SPAWN_PROTECTION: "0"`
(`infrastructure/docker/docker-compose.yml:397`), re-applied every boot by the
image, so the containerized server is nuke-proof — **a host-run server's
`server.properties` is still manual.** If a bot is mining nothing near spawn,
check this before you check the brain.

**Related mineflayer flake, same neighbourhood:** `placeBlock` can throw
"blockUpdate did not fire within 5000ms" when the placement actually landed.
`placeCarried` in `BotSession` verifies the world rather than trusting the
throw.

**A nuked world boots with default gamerules.** `task nuke` gives a fresh
world at `DIFFICULTY: easy` with vanilla rules — run the post-nuke re-apply
(`keepInventory true`, `doInsomnia false`, `mobGriefing false`) before the next
attempt. `spawn-protection` and `connection-throttle` are baked into the image
and are off that checklist.

---

## 8. Audit log and open items

### 8.1 Corrections applied to the source draft

This document started as a research draft assembled from the live wiki. The
twelve commands the benchmark machinery depends on were then re-checked
subpage by subpage. What changed:

| Claim in the draft | Verdict | Fix |
|---|---|---|
| `/difficulty` accepts `p\|e\|n\|h` and `0\|1\|2\|3` | **Wrong for Java** | Java 1.13 (17w45a) restricted it to string ids. Removed; §5.7 now says string ids only. |
| `/setworldspawn` pitch + non-Overworld support "recorded only as the pre-release", unverified | **Resolved** | Both landed in **1.21.9 Pre-Release 1 (25w31a)** — after 1.21.6. 1.21.6 is `[<pos>] [<angle>]`, Overworld-only since 1.20.5 (24w03a). |
| "Unverified whether `/clear` clears armor" | **Resolved** | The wiki states `/clear` clears inventory, hotbar, offhand, crafting grid and cursor, and does **not** clear armor or the ender chest. Recorded as a positive statement in §5.3 with the explicit `item replace` workaround kept. |
| `/spawnpoint` had no version caveats | **Incomplete** | Added: `angle` is 1.16.2 (20w29a), any-dimension is 1.16 (20w12a), and the optional `pitch` is 1.21.9-pre1 — not 1.21.6. |
| `/tick` subcommand list | **Incomplete** | Added `tick step stop` and `tick sprint stop`; noted `<time>` became optional in 23w44a. Op 3, rate 1.0–10000.0, default 20.0 all confirmed. |
| `/forceload` described as inert chunk residency | **Incomplete and misleading** | Since 1.21.5 forceloaded chunks get random ticks and crops grow without a player. Called out in §5.8 as a benchmark hazard. |
| `weather` duration "default 5 minutes" implied determinism | **Incomplete** | The omitted duration is random within a per-type band (clear 12000–180000, rain 12000–24000, thunder 3600–15600 ticks). §5.2 now says pass an explicit duration. |
| `time query (daytime\|gametime\|day)` | **Correct for 1.21.6, but fragile** | The live wiki now shows the 26.1 forms (`time query time`, `time query <timeline>`). Flagged in §1 and §5.1 so a future reader does not "fix" the correct syntax. |
| `doFireTick` listed as a plain rule | **Correct for 1.21.6** | Added the post-1.21.6 note that 25w44a removed it entirely in favour of `fire_spread_radius_around_player` — the clearest signal that the wiki's current rule table is not this version's. |
| gamerule camelCase → snake_case at 1.21.11 / 25w44a | **Confirmed** | Verified from `/w/Game_rule` (the `/w/Commands/gamerule` subpage does not carry the entry). Old→new mapping in §1 confirmed rule by rule. |
| `kill` with no target over RCON | **Confirmed** | With no `<targets>` and no executor entity the command reports "Failed". |
| `save-all flush`, `/clear`, `/weather`, `/teleport`, `/gamerule`, console context, 1.21.6 changelog | **Confirmed as written** | Op levels, syntax, and the "relative coordinates are relative to the executor" rule all check out. |

### 8.2 Still unverified — do not upgrade these without evidence

- **`/test` availability on a vanilla 1.21.6 dedicated server.** The wiki
  records it as added in 19w34a and "only available in IDE environment";
  whether the release server exposes it was not confirmed.
- **`/version` op level.** The 1.21.6 changelog says it prints version
  information "for singleplayer or operators" without naming a numeric level.
  §2 lists it as operator-gated, level unknown.
- **Exact 1.21.6 defaults for the second-tier game rules** in §5.6
  (`doImmediateRespawn`, `spawnRadius`, `playersSleepingPercentage`,
  `doPatrolSpawning`, `doTraderSpawning`, `doWardenSpawning`,
  `maxEntityCramming`, the damage rules). Query them live.
- **Whether `tick freeze` affects chunk loading.** The wiki says only "all
  gameplay elements … except players and any entity a player is riding".
- **The RCON sender's reported name** (`Server` vs `Rcon`). The
  `Command_context` page documents the generic server-console context and says
  nothing about RCON specifically.
- **Whether any command present in 1.21.6 has since been removed** from the
  wiki's current table. The table was read against a 26.x-era wiki, so only
  *additions* were auditable; a silent removal would leave a stale row in §2.
- **No retrieval timestamp** exists for the original assembly pass. The audit
  pass in §8.1 ran 2026-07-25 against the then-live wiki.
