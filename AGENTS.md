# AGENTS.md

Project overview, architecture, standard `task` commands, and the long list of
this-stack gotchas live in `README.md`, `CLAUDE.md`, and `docs/` — read those
first. This file only adds guidance specific to running in the Cursor Cloud
agent VM (Linux), which differs from the owner's Windows + Docker Desktop
machine that `CLAUDE.md` was written for.

## Cursor Cloud specific instructions

The dependency **update script** (`npm install`, `uv sync` for the two Python
services) runs automatically on VM start. Node 22, Java 21, `uv`, `go-task`,
and Docker are already installed in the snapshot. The notes below are the
non-obvious things you still have to do/know to actually run the stack.

### Docker daemon (start it once per session)

There is no systemd in this VM, so Docker does not auto-start. `/etc/docker/daemon.json`
is already configured for nested Docker (storage-driver `fuse-overlayfs` and
`containerd-snapshotter: false`, required by Docker 29). Start the daemon in the
background and make the socket usable, e.g.:

```sh
sudo dockerd >/tmp/dockerd.log 2>&1 &     # or run inside a tmux session
sudo chmod 666 /var/run/docker.sock       # ubuntu is in the docker group, but a fresh socket needs this until re-login
```

### The `mem_limit` / cgroup gotcha (why plain `task up` fails here)

This VM's cgroup-v2 namespace root is `domain threaded` and only has
`cpuset cpu pids` delegated — the `memory` controller is **not** available. Any
container that sets `mem_limit` (in the base compose: `postgres`, `redpanda`,
`minecraft`, `pov-rig`) makes `runc` try to write `memory.max` and dies at
startup with:

```
runc create failed: unable to apply cgroup configuration:
cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode
```

The fix is committed as `infrastructure/docker/docker-compose.cloud.yml`, which
sets those `mem_limit`s to `0` (unlimited → Docker skips the memory controller).
It is a no-op on machines where the memory controller works, so it is safe to
always layer on. Because `task up`/`up:all`/`dev:up` hardcode `-f docker-compose.yml`,
they will NOT pick up the override — bring the stack up with compose directly:

```sh
CC="docker compose -f infrastructure/docker/docker-compose.yml -f infrastructure/docker/docker-compose.cloud.yml --env-file .env"
$CC --profile infra up -d --wait          # Postgres, Redis, Redpanda, Prometheus, Grafana
node scripts/provision-topics.mjs         # Kafka topics (task up normally does this)
$CC --profile minecraft up -d --wait      # containerized Paper 1.21.6 (first boot ~30s world-gen)
$CC --profile infra --profile app up -d   # agent, memory, minecraft, event services (add --build after code changes)
```

If the override file is missing (e.g. working on a branch where it wasn't
merged), recreate it: it only needs `services: {postgres,redpanda,minecraft,pov-rig}`
each with `mem_limit: 0`.

### `.env` on this VM

Copy `.env.example` to `.env`, then set:
- `MC_HOST=minecraft` — there is no host Minecraft server on the VM; bots reach
  the containerized Paper server by its compose service name.
- `LLM_PROVIDER` — `OPENAI_API_KEY` is provided as a Cursor secret (injected
  into the process env). Set `LLM_PROVIDER=openai` for real `gpt-4o-mini`
  deliberation; compose reads the process-env key via `${OPENAI_API_KEY:-}` and
  it overrides the blank in `.env` (process env beats `--env-file`). Verified:
  villagers produce percept-grounded decisions (naming nearby villagers, reacting
  to specific mobs, reasoning about tool prerequisites) and `civ_llm_tokens_total{provider="openai"}`
  climbs on the agent-service `/metrics`. If no key is available (secret unset,
  no Ollama), use `LLM_PROVIDER=fake` — a deterministic offline provider that
  still drives the full perceive→deliberate→act→reflect loop for pipeline checks.
  (`LLM_PROVIDER=auto` walks openai → anthropic → ollama → fake automatically.)

### Hello-world / verifying the stack is live

With the app profile up, `task seed` (POST `localhost:8001/internal/seed`) seeds
the 6 villagers, spawns them as bots, and starts the tick loops. Verify:

```sh
docker exec ai-civilization-engine-minecraft-1 rcon-cli list        # should list 6 bots
curl -s "http://localhost:8081/events?limit=100" | python3 -m json.tool   # ledger: VillagerSpawned, DecisionMade, ActionRequested/Completed/Failed, MemoryFormed, RelationshipChanged
```

The dashboard is host-run (`task dashboard`, Next.js on `:3000`) and proxies to
the services on their host-mapped ports (`localhost:8001/8081/...`); its home
page shows the villager roster and a live SSE event feed, `/relationships` shows
the social graph.

### What does NOT apply here

The Windows/Docker-Desktop gotchas in `CLAUDE.md` (the Docker Desktop socket
rename dance, Git Bash `/c` path mangling, `cmd /c .\gradlew.bat`, PowerShell
volume mounts, host `bukkit.yml`/`server.properties` edits) are irrelevant on
this Linux VM — use `./gradlew` and normal POSIX shells. The containerized Paper
server bakes in its `spawn-protection=0` / `connection-throttle=-1` patches, so
those host-server caveats also do not apply.
