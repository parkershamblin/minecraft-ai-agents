# Failure taxonomy corpus

Across 25,690 autonomous decisions by local 8–12B models, only 13.0% were
malformed — 92.2% of those were simple numeric-bounds slips and **zero** ever
picked an invalid action verb — so the JSON tool contract holds and the cheap
fix is a tighter decode grammar, not GPU fine-tuning.

Every number above traces to `metrics.json` (`decisions.total`,
`decisions.malformed_pct`, `decisions.malformed_breakdown_pct.numeric_bounds`,
`decisions.invalid_verbs`), recomputed from the committed ledger windows by
`compute_metrics.py`.
