# RB-race sensitivity sweep (Phase 3b)

One axis at a time against the frozen v3 baseline: every knob except the
named axis holds its `bench/race/frozen-config.json` value, the pristine
pinned-seed world is restored per block, and the honesty gate is the same
as the model table's. **These rows are not model-comparison rows** and
never enter `RACE_REPORT.md`.

Δ is against the arm at the axis baseline, within the same model. It is a
difference of small-N means, not a test: with N=5 per arm the CI columns
are the honest read.

| Model | Axis | Arm | N | Win rate | Time-to-goal s (won) | Δ vs baseline |
|---|---|--:|--:|--:|--:|--:|
| `llama3.1:8b` | OLLAMA_NUM_CTX | 4096 | 5 | 5/5 | 749.1 ± 339.5 | -39.4 |
| `llama3.1:8b` | OLLAMA_NUM_CTX | 8192 (baseline) | 5 | 5/5 | 788.6 ± 636.5 | — |
| `llama3.1:8b` | OLLAMA_NUM_CTX | 16384 | 0 | 0/0 | — | — |
| `llama3.1:8b` | TICK_INTERVAL_SECONDS | 15 | 5 | 5/5 | 533.1 ± 152.6 | -75.5 |
| `llama3.1:8b` | TICK_INTERVAL_SECONDS | 30 (baseline) | 5 | 5/5 | 608.6 ± 136.7 | — |
| `llama3.1:8b` | TICK_INTERVAL_SECONDS | 60 | 5 | 3/5 | 1181.1 ± 1077.4 | +572.5 |

## Coverage

**Missing coverage.** These runs never produced a kept row, so the N column above is short by exactly them. Listed because a silent truncation reads as coverage:

- `llama3.1:8b` OLLAMA_NUM_CTX=16384 run 1: block-setup-failed — block setup failed: villagers still offline after 300s: Elara, Wren, Ansel, Petra, Fen — last list: 'There are 26 of a max of 30 players online: Gideon, pov_cam_4, pov_cam_1, Bram, Juniper, Yara, Maren, Ines, Sable, Ulric, pov_cam_3, Cassia, Dagny, Hollis, ...'

**Recovered failures (audit trail, NOT missing coverage).** Each of these failed once, then the same run index was re-raced successfully after the cause was fixed — the N column above already counts the successful take. They are kept in the manifest so the failure is on the record rather than edited out:

- `llama3.1:8b` OLLAMA_NUM_CTX=4096 run 1: block-setup-failed — block setup failed: villagers still offline after 300s: Elara, Wren, Ansel — last list: 'There are 26 of a max of 30 players online: Bram, pov_cam_6, Dagny, pov_cam_2, Hollis, Maren, Gideon, Nils, Vesper, Tansy, Juniper, Fen, Cassia, pov_cam_4, ...'
- `llama3.1:8b` OLLAMA_NUM_CTX=8192 run 1: block-setup-failed — block setup failed: villagers still offline after 300s: Elara, Ansel, Petra — last list: 'There are 26 of a max of 30 players online: pov_cam_4, Bram, Dagny, pov_cam_2, Gideon, Tansy, Juniper, pov_cam_1, Fen, Ines, Sable, Nils, Wren, Ulric, ...'


Per-arm process timeout scales with the tick arm (`raceTimeoutSeconds` in
the manifest): the 75-minute watchdog inside `race-rb2.mjs` is
inter-milestone, not total, so a slower tick would otherwise be censored
by a fixed process bound in the direction that flatters it.
