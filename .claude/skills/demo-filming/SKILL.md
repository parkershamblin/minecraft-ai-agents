---
name: demo-filming
description: Use when filming, re-shooting, or verifying a demo clip — OBS takes via scripts/obs-record.mjs, skill-drill demos (scripts/skill-drill-u*.ts), the demo-cam bot, demos/**/RESULT.json or STATUS.md evidence, or ledger-rendered race films (scripts/render-race-film.py, film/). Delivers the take-to-approved-clip procedure: stack lock, camera decision, recording, clip checks, evidence contract, dual delivery.
---

## When to use / when not

Use for any work that produces a demo clip or race film: OBS takes of live-stack
demos, skill-gate re-shoots, D-series `capture.sh` runs, ledger-slice race
renders. NOT for: getting the stack deployed and healthy first (see the
deploy-service skill), ledger query grammar or RCON probing (see the
live-forensics skill), running benchmark sweeps (see the race-sweep skill), or
writing up a run's numbers (see the bench-report skill).

## 1. Serialize on the stack lock

One live stack, one GPU — only ONE session may drive docker/Minecraft/Ollama at
a time. Code work in worktrees is parallel; the world is not.

- [ ] Check `demos/.stack.lock`. Held by someone else → pick non-conflicting work, never clobber.
- [ ] Take it with your demo/session name; delete it when done.

```powershell
if (Test-Path demos/.stack.lock) { Get-Content demos/.stack.lock; throw "stack locked - pick other work" }
Set-Content demos/.stack.lock "<demo-name> <session>"
# ... takes ...
Remove-Item demos/.stack.lock
```

## 2. State the camera decision before every take

One line, pre-take, recorded in RESULT.json's scenario/recordedAt: which camera
and why (ad-hoc camera choice shipped two frozen-looking clips).

| Demo content | Camera | Viewer |
|---|---|---|
| Roaming/mining — actor moves, faces dig targets | actor's first-person prismarine-viewer, served by the skill-drill script | :3100 |
| Staged fixed-area — stations, arenas, foreground action | dedicated grounded cam bot `scripts/demo-cam.ts` (lookAt loop on the focus point) | :3101 |

```powershell
npx tsx scripts/demo-cam.ts <focusX> <focusY> <focusZ>   # serves http://localhost:3101
docker exec ai-civilization-engine-minecraft-1 rcon-cli tp demo_cam <x> <y> <z>   # SURFACE vantage
```

- Never float the cam: the server kicks floating players (no allow-flight); demo-cam exits loudly on kick.
- Probe a frame BEFORE rolling: open the viewer and confirm the actor is visible and unoccluded — u5 take-4 burned a take with the cam inside tall grass.
- Open viewer tabs only via claude-in-chrome managed tabs (tabs_create + navigate) so they CAN be closed programmatically; OS `start` tabs are unreachable. Stale prismarine-viewer tabs reconnect to new servers keeping the OLD camera position (CLAUDE.md gotcha).

## 3. Record through the script, never the GUI

`scripts/obs-record.mjs` (OBS websocket 5.x; creds `OBS_WEBSOCKET_URL` /
`OBS_WEBSOCKET_PASSWORD` from `.env`) idempotently ensures scene `skill-demos`
+ a DXGI display-capture input, refuses a double start, and on stop waits ~2s
for OBS to finalize the container before moving the file.

```powershell
node scripts/obs-record.mjs start
npx tsx scripts/skill-drill-u<N>.ts          # the take
node scripts/obs-record.mjs stop --out demos/skills/<unit>/out.mp4
```

- ONE process orchestrates start → take → stop: a zombie second process once stopped OBS mid-take (u5 caveat).
- Never move/copy the mp4 yourself before `stop` returns — the mux may not be finalized.
- OBS missing on this box: `winget install OBSProject.OBSStudio` (allowlisted).

## 4. Clip verification gate — unskippable

Two frozen clips shipped without these checks; owner review cycles are the
scarce resource. All four, before any clip is offered:

- [ ] Probe-frame checked pre-roll (section 2)
- [ ] freezedetect over the finished recording; any `freeze_start` explained (terminal-only demos freeze legitimately)
- [ ] Phase frames extracted — one per demo phase — each eyeballed
- [ ] ffprobe duration/size, and those numbers are what goes into STATUS.md ("ffprobe-verified")

```powershell
ffmpeg -hide_banner -i demos/skills/<unit>/out.mp4 -vf freezedetect=n=-60dB:d=3 -f null - 2> freeze.log
Get-Content freeze.log
ffmpeg -ss 00:00:12 -i demos/skills/<unit>/out.mp4 -frames:v 1 phase-1.png    # repeat per phase timestamp
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 demos/skills/<unit>/out.mp4
```

ffmpeg/ffprobe live at `C:\Program Files\WinGet\Links\` (probe via python
`shutil.which` if PATH fails). The Bash allowlist matches single `ffmpeg *`
commands — pipes/compounds fall outside the pattern, so redirect stderr to a
file instead of piping.

## 5. Evidence contract

**Skills-gate demos** — per-unit `demos/skills/<unit>/RESULT.json` (models:
`u5-explore-giveback`, `u8-ore-smelt`):

- `unit`, `pr`, `recordedAt` (take number + why re-shot), `clip`, `clipDurationS`, `scenario`
- `invocations` carrying the REAL returned result objects, never intended ones
- `evidence.onCamera` + `llmCallsDuring`
- `caveats`: disclose ALL staging (e.g. setblock-staged ore) and every rehearsal-caught bug — that trail banked two real bugs instead of losing them

**D-series demos** (`demos/<name>/`, model: `failure-taxonomy-corpus`) — five
done-criteria before GREEN: `run.sh` · /verify observation · `metrics.json`
reproducing every claimed number from committed data · `capture.sh` → out.mp4 ·
`CAPTION.md` — then rerun `capture.sh` from a clean checkout (`.claude/loop.md`
is the loop contract).

**STATUS.md** (`demos/STATUS.md`, `demos/skills/STATUS.md`) after EVERY
iteration: status GREEN/VERIFYING/BUILDING/BLOCKED + the single next action +
owner questions. Blocked demos record the question and move on — never park.
STATUS.md is how an autonomous loop resumes after compaction or a crash.

## 6. Deliver both ways, then close tabs

- [ ] Commit + push the clip; get the GitHub blob URL.
- [ ] SendUserFile the mp4 AND paste the GitHub link — the owner often reviews from a phone; mobile remote drops chat binaries, GitHub mobile plays mp4 via Raw.
- [ ] After each approval: close the viewer tabs, check the unit off in STATUS.md, only then start the next take. Release the stack lock when the session's takes are done.

## 7. Race films render from the ledger slice

The replay/B-roll path is `scripts/render-race-film.py` over an attempt's
ledger slice — no game client, no OBS, no hand-edited timeline; every on-screen
beat is a ledger event (the honest-race property carried into the artifact).

```powershell
uv run --with pillow --with imageio --with imageio-ffmpeg python scripts/render-race-film.py film/flagship-slice.json film/out.mp4
```

- SRT captions timecode to the RACE CLOCK: 00:00 = the harness "attempt … STARTED" line; sync OBS footage to that moment and the beats land on real ledger timestamps (`film/flagship-take-1.srt` is the model).
- Keep the featured attempt's curl receipt command in `film/README.md`; ledger query grammar itself is the live-forensics skill.
- Golden gate: `bench/test_race_metrics.py` pins the metric extractor against `film/flagship-slice.json` — run it after touching the extractor or the slice format:

```powershell
cd bench; uv run --python 3.12 --with pytest pytest -q
```

- Stale-doc caution (verified 2026-08-07): `film/README.md` line 23 still calls `pov-grid.html` fleet-lethal, but `docs/demo-rb.md` §2b corrected the history — SAFE since the pov-sidecar. Trust demo-rb.md.

## Verification

Prove each step before calling a clip done:

```powershell
Test-Path demos/.stack.lock                                   # False after release (your name mid-session)
Get-Content freeze.log                                        # exists; freeze_start lines explained or absent
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 demos/skills/<unit>/out.mp4
Get-Content demos/skills/<unit>/RESULT.json | ConvertFrom-Json  # parses; invocations carry real results
git log --oneline -1 -- demos/skills/<unit>/out.mp4           # clip committed → GitHub link works
git diff --stat -- demos                                      # STATUS.md edit included this iteration
cd bench; uv run --python 3.12 --with pytest pytest -q        # race-film extractor golden gate (if film touched)
```

The ffprobe output must MATCH the numbers written into STATUS.md/RESULT.json —
sample first, then write the number.
