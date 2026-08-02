# prismarine-viewer 26.2 compatibility assets

Prebuilt atlas + blockStates for Minecraft Java 26.2, generated from
`minecraft-assets` 1.21.8 by MineBot’s
`scripts/prepare-prismarine-viewer-26.2.cjs` (real `canvas`).

This repo stubs `canvas` → `noop2` (browser POV renders client-side), so
postinstall **copies** these into `node_modules/prismarine-viewer/public/`
instead of regenerating. See `docs/runbooks/minecraft-26.2-local.md`.
