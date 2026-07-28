# Demo sprint status

Branch: `demo-sprint` (from `feedback-loop-close`). Commits direct to branch;
PRs pending per demo (owner will PR later). Budget: $7 hard cap, harness-enforced.

`run-skill-generator` skill NOT available in print mode (not in skill list) —
noted per instructions, continuing. Stack-boot recipe lives in CLAUDE.md
(`task up:all`, Paper via compose `--profile minecraft up -d --wait minecraft`).

## Demo status

| Demo | Status | Next action |
|------|--------|-------------|
| D2 failure-taxonomy-corpus | VERIFYING | metrics.json GREEN (all brief numbers reproduce: 25,690 dec / 3,351 err 13.0% / 92.2% bounds / 0 invalid verbs / 13,778 AF / 2.0% plumbing). out.mp4 rendering in background (`uv run --with matplotlib demos/failure-taxonomy-corpus/render_chart.py`). Next: verify mp4 duration/size, commit |
| D1 event-driven-vs-wallclock | PENDING | Read scheduler.py; wire ActionCompleted/ActionFailed wake + budget cap; A/B on Ollama |
| D5 brain-swap | PENDING | Config-flag model swap demo, three Ollama models; show (never run) paid config diff |
| D3 tool-layer-skills | PENDING | Vendor Tier 1 plugins (auto-eat, armor-manager, tool) as reflexes below deliberation |
| D4 race-film | PENDING | Best-of-N race + capture; SKIP if <$2 budget remains at start |

## Stack lock

None held. One demo drives docker/Minecraft/Ollama at a time via `demos/.stack.lock`.

## Questions for owner

- None yet.

## Resume state

- Branch `demo-sprint` created. D2 files all written under demos/failure-taxonomy-corpus/
  (compute_metrics.py, render_chart.py, run.sh, capture.sh, CAPTION.md, metrics.json).
- Window file shape: `{"data": [envelopes]}`, `eventType` key, `payload.decision` is a
  STRING "verb {params}". Plumbing split imported live from awareness.py `_PLUMBING_CODES`.
- Permission gotchas this run: Bash allowlist takes `uv run …` single commands; raw
  `ffmpeg`, pipes, and PowerShell compound commands DENIED. ffmpeg exists at
  `C:\Program Files\WinGet\Links\ffmpeg.EXE` (probed via python shutil.which).
- If mp4 render died mid-run: re-run capture.sh (regenerates metrics + mp4).
- Budget at this checkpoint: ~$3.2 of $7 remaining. D4 already below the $2 line
  once D1/D3/D5 spend anything — expect BLOCKED("budget").
