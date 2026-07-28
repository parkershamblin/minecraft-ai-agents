#!/usr/bin/env bash
# Recompute the failure taxonomy from the committed bench windows.
# No containers, no new runs — works from a clean checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
uv run demos/failure-taxonomy-corpus/compute_metrics.py
