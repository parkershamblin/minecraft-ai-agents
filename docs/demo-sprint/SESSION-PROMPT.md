# Demo sprint — unattended ultracode session kit

Everything needed to launch a Claude Code Fable 5 session that loops until
five recordable demos exist. Feature claims verified against official docs
2026-07-28; two commands from earlier advice do NOT exist and were removed
(`/subtask`, "+500k" token directives — `--max-budget-usd` is print-mode only,
so an interactive session has no budget flag; cost control is the allowlist
plus the repo's own breakers).

## Launch checklist (human, once)

```powershell
cd D:\Documents\GitHub\minecraft-ai-agents
claude --model fable --effort ultracode
```

Then, in order:

1. `/run-skill-generator` — records the stack-boot recipe into
   `.claude/skills/run-*/` so `/verify` can launch the real app instead of
   guessing. Run once, first.
2. Confirm the allowlist landed: `.claude/settings.json` must contain the
   `permissions.allow` block (committed with this kit). Workflow subagents
   always run acceptEdits and inherit this list — anything missing prompts
   mid-run and stalls the night.
3. Paste the session prompt below.
4. After the proposed workflow plan is approved:

   ```
   /goal demos/STATUS.md shows every demo GREEN and each demo's out.mp4, metrics.json, and CAPTION.md exist on disk
   ```

5. Start the iteration engine (bare — self-paced, reads `.claude/loop.md`):

   ```
   /loop
   ```

Crash recovery: relaunch `claude --model fable --effort ultracode`, re-paste
the prompt, re-issue the same `/goal` and `/loop`. All state lives in
`demos/STATUS.md` + on-disk artifacts, so the new session resumes exactly
where the old one died. `/goal` survives compaction but NOT a process kill —
the state file is the real memory.

## Session prompt (paste-ready)

```
Read docs/CONTEXT-agent-brief.md first. It is ground truth. The platform is
frozen: no new services, no refactors of the six existing ones. All new
capability goes in the agent tool layer. Never git revert 56823ad. Never set
LLM_PROVIDER to a paid provider. Before any compose deploy that touches LLM
config, run `env | grep LLM_` — this machine's shell profile can export a
stale race-config block that beats --env-file.

GOAL: five demos under demos/, each with a passing verify gate and a captured
artifact, demos/STATUS.md all GREEN.

A demo is DONE only when:
1. demos/<name>/run.sh boots it from a clean checkout, no manual steps.
2. /verify observes the intended behavior in the running app — not a test.
3. demos/<name>/metrics.json holds the numbers the demo claims, derived from
   the ledger or bench outputs, never hand-typed.
4. demos/<name>/capture.sh produces demos/<name>/out.mp4 (60-180s). Primary:
   OBS via obs-websocket (OBS is NOT installed — first capture task:
   winget install OBSProject.OBSStudio, enable websocket server, port 4455,
   password into .env, script start/stop around the run). Fallback if OBS
   blocks more than 2 iterations: the ledger-rendered pipeline
   (scripts/render-race-film.py) — fix its hardcoded CAPTIONS/NAME_OF/
   duration first; they are stale (they still claim llama/10s tick).
5. demos/<name>/CAPTION.md: one-sentence claim a hiring manager understands;
   every number in it traces to metrics.json.

THE DEMOS (priority order — capability work first):
D1 event-driven-vs-wallclock: wire the ActionCompleted/ActionFailed wake in
   services/agent-service/src/agent_service/brain/scheduler.py (threat/
   hazard/chat wakes ALREADY exist — read scheduler.py before writing
   anything; the missing piece is small, the real design work is the wake
   predicate and a budget-derived cap — unconditional firing is a documented
   GPU stampede). Clock tick becomes a ~300s heartbeat. A/B the same scenario
   on Ollama. Metrics: LLM calls/min, no-op decision fraction, reaction
   latency to a threat percept.
D2 failure-taxonomy-corpus: NO new runs, NO containers. The corpus is the
   committed bench windows: bench/results/sweep/slices/*.window.json —
   25,690 DecisionMade events, 3,351 with payload.error==true (13.0%), 92.2%
   of those numeric-bounds violations (payload.reasoning holds the literal
   jsonschema message), 0 invalid verbs ever. The plumbing-vs-substantive
   code split lives in services/agent-service/src/agent_service/brain/
   awareness.py — reuse it, do not reinvent. Recompute from the slices (not
   the live ledger — different totals), chart it, caption it. If you also
   query the live ledger (GET :8081/events): ALWAYS oldest-first, use since=.
D3 tool-layer-skills: vendor Tier 1 mineflayer plugins (mineflayer-auto-eat,
   mineflayer-armor-manager, mineflayer-tool — pin exact versions, MC 1.21.6,
   mineflayer 4.37.1) wired BELOW deliberation as reflexes — zero token
   cost — plus one composed multi-step task through the existing 7-verb
   contract. Fresh code only; the reverted skills arc stays reverted.
D4 race-film: best-of-N race, free Ollama, scripts/race-rb2.mjs (exit codes:
   0 won / 2 stalled / 3 aborted — loop on them). Paper server:
   docker compose -f infrastructure/docker/docker-compose.yml --env-file .env
   --profile minecraft up -d --wait minecraft. Fleet: node
   scripts/spawn-fleet.mjs then node scripts/despawn-fleet.mjs 6 (racers are
   villagers.json[0:6]; task seed spawns nothing for existing villagers).
   Capture per rule 4.
D5 brain-swap: same villager, same schemas, gemma3:12b -> llama3.1:8b ->
   gemma4:latest by config flag only, zero code changes. Show the anthropic/
   openai config diff on screen but NEVER execute a paid call.

HOW TO WORK:
- Use a dynamic workflow to plan the fan-out. Use /batch to give each demo
  its own worktree + background subagent + PR, so one broken demo cannot
  block the others. Worktree rules: copy .env in (gitignored, not carried by
  worktrees); compose run from a worktree attaches to the SAME live project,
  so a worktree deploy replaces the running container.
- RUNTIME IS SERIALIZED: one live stack, one GPU. Only ONE demo may drive
  docker/Minecraft/Ollama at a time — take demos/.stack.lock (write your
  demo name into it; delete it when done; respect an existing lock). Code
  work in worktrees is parallel; the world is not.
- STATUS protocol: update demos/STATUS.md after every iteration — per demo
  one of BLOCKED/BUILDING/VERIFYING/GREEN, plus the single next action and
  any question for the owner. It is how the loop resumes after compaction or
  a crash. Never leave it stale.
- BLOCKED demos: record the question in STATUS.md and move to the next demo.
  Do not stop the run. Do not park on AskUserQuestion.
- NEVER run task nuke (interactive confirm + volume-lethal). Never change the
  live stack's LLM_PROVIDER. After any merge into a running service: deploy
  with up -d --build --no-deps <service> and grep a marker symbol inside the
  container before trusting it.
- Cheapest evidence first: ledger queries before live runs, local models for
  everything. D2 first (needs only two containers), then D1, D3, D5, D4 last
  (needs the full stack + Paper + warmed Ollama — first tick cold-loads the
  model).

Start: read the brief, then scheduler.py, awareness.py, and
scripts/race-rb2.mjs. Then propose the workflow plan for approval.
```

## Notes on what was verified vs the original advice

- REAL and used here: `/goal`, `/loop` + `.claude/loop.md`, `/batch`,
  `/run-skill-generator` + `/run` + `/verify`, `/workflows`, `/tasks`,
  `--effort ultracode`, `--worktree`, `disallowed-tools` skill frontmatter,
  the acceptEdits-inherits-allowlist behavior of workflow subagents.
- NOT REAL, removed: `/subtask` (use subagents or `/fork`); any "+500k"
  session token budget (`--max-budget-usd` works only with `-p`).
- The original D2 ("free-form vs typed actions") was dropped: this repo has
  never had a free-form action path — 25,690 decisions, zero invalid verbs.
  The corpus itself is the demo.
