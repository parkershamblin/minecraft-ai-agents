#!/usr/bin/env bash
# Render the animated taxonomy chart (~66s) to out.mp4.
# Requires ffmpeg on PATH. Rendered chart allowed for this demo (no game footage).
set -euo pipefail
cd "$(dirname "$0")/../.."
uv run demos/failure-taxonomy-corpus/compute_metrics.py
uv run --with matplotlib demos/failure-taxonomy-corpus/render_chart.py
