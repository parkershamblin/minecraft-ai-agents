# Runbook: volume backup & restore (SV-5b)

The three stateful volumes are the world (`minecraft-data`), the databases —
ledger, villagers, memories (`postgres-data`) — and the Kafka log
(`redpanda-data`). A backup is a cold tar of each; anything less (live copy)
can tear Postgres or the anvil files. **Run from PowerShell** — Git Bash
mangles `-v /paths` in `docker run` (CLAUDE.md gotcha).

First executed: 2026-07-17 → `D:\backups\ai-civilization-engine\2026-07-17\`
(minecraft 253 MB · postgres 533 MB · redpanda 44 MB; all three verified
listable).

## Backup (~5 min)

```powershell
# 1. Flush the world to disk (Paper's 10s stop window can drop late state)
docker exec ai-civilization-engine-minecraft-1 rcon-cli save-all

# 2. Cold stop — volumes survive `down`
task down

# 3. Tar each volume from a throwaway alpine container
$dest = "D:\backups\ai-civilization-engine\$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($vol in 'minecraft-data','postgres-data','redpanda-data') {
  docker run --rm -v "ai-civilization-engine_${vol}:/data:ro" `
    -v "${dest}:/backup" alpine tar czf "/backup/$vol.tar.gz" -C /data .
}

# 4. Verify every tarball lists cleanly (a truncated tar dies here, not at restore time)
foreach ($vol in 'minecraft-data','postgres-data','redpanda-data') {
  docker run --rm -v "${dest}:/backup:ro" alpine sh -c "tar tzf /backup/$vol.tar.gz | wc -l"
}

# 5. Bring everything back
task up:all
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
  --profile minecraft up -d --wait minecraft
task seed        # bot sessions are in-memory; the recreate dropped the fleet
docker exec ai-civilization-engine-minecraft-1 rcon-cli list   # expect VILLAGER_COUNT bots
```

## Restore

Same shape, reversed — **restore all three volumes together** from the same
dated set. The ledger, the world, and the Kafka offsets are one consistent
snapshot; mixing dates resurrects the stale-offset replay class of bug
(CLAUDE.md, Corollary 2).

```powershell
task down
$src = "D:\backups\ai-civilization-engine\<DATE>"
foreach ($vol in 'minecraft-data','postgres-data','redpanda-data') {
  docker run --rm -v "ai-civilization-engine_${vol}:/data" `
    -v "${src}:/backup:ro" alpine sh -c "rm -rf /data/* && tar xzf /backup/$vol.tar.gz -C /data"
}
task up:all
# minecraft profile + seed as above
```

After a restore, re-check the world knobs that live outside volumes or get
re-seeded: difficulty (`rcon-cli difficulty`), gamerules, and
`connection-throttle: -1` in `/data/bukkit.yml` (survives restore — it's in
minecraft-data — but verify).

## When to run

- Before any phase that rewrites world or ledger state (RB harness attempts,
  `task nuke`, difficulty flips, migration experiments).
- Before mineflayer/Paper version bumps.
