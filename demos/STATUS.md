# Demo sprint status

Branch: `demo-sprint` (from `feedback-loop-close`). Commits direct; PRs pending
per demo (owner will PR later). Budget: $7 hard cap — EXHAUSTED this run
(~$6 spent; huge cached context made each turn ~$0.15–0.35).

`run-skill-generator` skill NOT available in print mode — noted, continued.
Stack-boot recipe: CLAUDE.md (`task up:all`; Paper via compose
`--profile minecraft up -d --wait minecraft`).

## Demo status

| Demo | Status | Detail |
|------|--------|--------|
| D2 failure-taxonomy-corpus | **GREEN** | metrics.json reproduces every brief number from the 119 committed windows: 25,690 decisions / 3,351 malformed 13.0% / 92.2% numeric bounds / 5.3% not-JSON / 2.5% params shape / **0 invalid verbs** / 13,778 ActionFailed / 2.0% plumbing (split imported live from awareness.py `_PLUMBING_CODES`). out.mp4: 66.0s, 0.9 MB, ffprobe-verified. run.sh + capture.sh + CAPTION.md done. PR pending. |
| D1 event-driven-vs-wallclock | BUILDING | Wake WIRED + TESTED, A/B run NOT done (budget). `percepts.py`: `_wakes_deliberation` predicate + `on_outcome_percept` hook after the `_ACTION_TYPES` push; `main.py` wires it to `scheduler.request_reactive`. Predicate: ActionFailed wakes iff errorCode ∉ `_PLUMBING_CODES` (SUPERSEDED floods ~13/run — stampede guard); ActionCompleted wakes iff action ∈ {gather, craft, hunt, move, follow} (idle/chat never). Cap = scheduler's existing cooldown 15s + max 3 reactive/5min per villager. Heartbeat = set `TICK_INTERVAL_SECONDS=300` (config, no code). agent-service 245 tests green (4 new in `tests/test_outcome_wake.py`). NOT deployed. |
| D5 brain-swap | BLOCKED("budget") | Untouched. Plan: same villager, gemma3:12b → llama3.1:8b → gemma4:latest via `LLM_MODEL_OLLAMA` flag only; show (never run) anthropic/openai config diff. |
| D3 tool-layer-skills | BLOCKED("budget") | Untouched. Vendor mineflayer-auto-eat / -armor-manager / -tool pinned for mineflayer 4.37.1 / MC 1.21.6, as reflexes below deliberation; one composed task through the 7-verb contract. |
| D4 race-film | BLOCKED("budget") | Untouched, per rule (<$2 remaining before start). |

## Next action (single)

D1 A/B: deploy agent-service (`up -d --build --no-deps agent-service`, BOTH
profiles, `env | grep LLM_` first — shell profile exports a stale race block),
run same scenario on Ollama at tick 30 baseline vs tick 300 + wakes; metrics:
LLM calls/min, no-op decision fraction, threat-reaction latency (ledger,
`since=` — reads are oldest-first).

## Questions for owner

- D1 wake predicate + completed-action set above: sign off before A/B, or adjust.
- OBS never installed (D4 not reached) — `winget install OBSProject.OBSStudio` when D4 starts.

## Stack lock

None held. Nothing live was touched this run (no containers, no deploys).

## Resume state (for the next run of this prompt)

- Branch `demo-sprint`, all work committed. D2 complete under
  demos/failure-taxonomy-corpus/ — re-verify with `bash demos/failure-taxonomy-corpus/run.sh`.
- Window file shape: `{"data": [envelopes]}`, `eventType` key, `payload.decision`
  is a STRING `"verb {params}"`.
- Permission gotchas this run: Bash allowlist takes single `uv run …` commands;
  raw `ffmpeg`, `py`, pipes, and every PowerShell compound DENIED. ffmpeg at
  `C:\Program Files\WinGet\Links\ffmpeg.EXE` (probe via python `shutil.which`).
- Start next run at D1 A/B (respect demos/.stack.lock), then D5 (cheap: config
  flags + ledger reads), then D3, then D4.
