# Minecraft Java Edition 26.2 data

This local package layers Java Edition 26.2 (protocol 776) data over
`minecraft-data` 3.112.0 as a temporary compatibility layer.

The generated JSON files under `data/pc/26.2` come from
[PrismarineJS/minecraft-data pull request 1211](https://github.com/PrismarineJS/minecraft-data/pull/1211)
at commit `8385febf94b118eab02389fcf8155590047029ae`. That pull request was closed
without being merged or reviewed, so this data is not presented as an upstream
release. It has been validated here with registry/protocol tests and a live
connection to the official 26.2 server. `SHA256SUMS` pins the exact imported
files.

## About the checksum manifest

`SHA256SUMS` pins every file under `data/pc/26.2`. Regenerate it only when the
vendored data is deliberately replaced, using
`node scripts/update-vendor-checksums.cjs`; `--check` verifies without writing.
Never regenerate it to silence a failing test — the manifest exists to prove the
data still matches what was imported.

The manifest was originally generated on Windows from CRLF-normalized bytes,
while git checks the files out with LF endings on Linux and macOS, so every
checksum failed on those platforms. The manifest now pins the LF bytes as
committed, and `.gitattributes` marks this directory `-text` so no platform
rewrites them again. The content itself was unchanged by this: each committed
file, converted back to CRLF, reproduces its original digest from the previous
manifest exactly, which is what established that only line endings differed.

The protocol file includes local corrections verified against the official
26.2 server bytecode and live packets: `ItemStackTemplate` is used for
advancement icons and recipe item-stack displays, and the data-component IDs
include the 26.2 additions omitted by the source pull request. The template
type intentionally follows `Slot` in the type table because ProtoDef's compiler
otherwise renames the anonymous Slot component-count variables without updating
their array expressions.

Play serverbound packet IDs were corrected against
`GameProtocols.SERVERBOUND_TEMPLATE` from the 26.2 server jar. The unmerged
data PR omitted `PingPacketTypes.SERVERBOUND_PING_REQUEST` at `0x26` (it lives
outside `GamePacketTypes`, so a naive dump misses it), which shifted every
later ID down by one and caused immediate kicks when `block_dig` was decoded as
`player_abilities` and `use_item` as `use_item_on`. Trailing IDs now match the
jar through `custom_click_action` at `0x44`, including `teleport_to_entity` at
`0x40`.

The source repository identifies the data as MIT licensed. Some generated data
may retain licenses from its underlying sources, as noted in the
[upstream license section](https://github.com/PrismarineJS/minecraft-data#license).

The wrapper delegates every other Minecraft version to the published
`minecraft-data` package, so existing supported versions keep their upstream
behavior.
