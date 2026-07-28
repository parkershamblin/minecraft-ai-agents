"""Render the failure-taxonomy animated chart to out.mp4 (~66s).

Every number on screen is read from metrics.json (never hand-typed).
Requires: ffmpeg on PATH, matplotlib (run via `uv run --with matplotlib`).
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import animation  # noqa: E402

HERE = Path(__file__).resolve().parent
M = json.loads((HERE / "metrics.json").read_text(encoding="utf-8"))

FPS = 12
DUR = 66  # seconds
FRAMES = FPS * DUR

BG = "#111418"
FG = "#e8eaed"
DIM = "#9aa0a6"
ACCENT = "#4c8dff"
WARN = "#e8710a"
OK = "#34a853"

dec = M["decisions"]
ex = M["executor"]
bd = dec["malformed_breakdown"]
bd_pct = dec["malformed_breakdown_pct"]


def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def scene_progress(t, start, dur):
    return ease((t - start) / dur)


fig = plt.figure(figsize=(12.8, 7.2), dpi=100)
fig.patch.set_facecolor(BG)


def clear():
    fig.clf()
    fig.patch.set_facecolor(BG)


def title_scene(t):
    clear()
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    p = scene_progress(t, 0, 3)
    n_dec = int(dec["total"] * p)
    n_files = M["corpus"]["files"]
    ax.text(0.5, 0.68, "Failure taxonomy of an LLM villager fleet",
            ha="center", color=FG, fontsize=30, weight="bold")
    ax.text(0.5, 0.56, f"{n_dec:,} decisions · {n_files} committed bench windows · recomputed offline",
            ha="center", color=DIM, fontsize=17)
    if t > 3:
        a = scene_progress(t, 3, 2)
        ax.text(0.5, 0.40, f"malformed: {dec['malformed']:,}  ({dec['malformed_pct']}%)",
                ha="center", color=WARN, fontsize=22, alpha=a)
        ax.text(0.5, 0.30, f"invalid action verbs: {dec['invalid_verbs']}  (ever)",
                ha="center", color=OK, fontsize=22, alpha=a)
    ax.text(0.5, 0.08, "source: bench/results/sweep/slices/*.window.json",
            ha="center", color=DIM, fontsize=11)


def decision_scene(t):
    clear()
    ax = fig.add_axes([0.30, 0.15, 0.62, 0.62])
    ax.set_facecolor(BG)
    labels = {"numeric_bounds": "numeric bounds", "not_json": "not JSON",
              "params_shape": "params shape", "other": "other"}
    keys = [k for k, _ in sorted(bd.items(), key=lambda kv: -kv[1])]
    p = scene_progress(t, 8, 4)
    vals = [bd[k] * p for k in keys]
    ax.barh([labels[k] for k in keys][::-1], vals[::-1], color=[WARN, ACCENT, ACCENT, ACCENT][::-1])
    ax.set_xlim(0, max(bd.values()) * 1.15)
    for s in ax.spines.values():
        s.set_color(DIM)
    ax.tick_params(colors=FG, labelsize=15)
    if p > 0.98:
        for k in keys:
            ax.text(bd[k] + max(bd.values()) * 0.01, [labels[x] for x in keys][::-1].index(labels[k]),
                    f"{bd[k]:,}  ({bd_pct[k]}%)", va="center", color=FG, fontsize=14)
    fig.text(0.06, 0.86, "What breaks when a small model decides?", color=FG, fontsize=24, weight="bold")
    fig.text(0.06, 0.79, f"{dec['malformed']:,} malformed of {dec['total']:,} decisions ({dec['malformed_pct']}%)",
             color=DIM, fontsize=16)
    if t > 20:
        a = scene_progress(t, 20, 2)
        fig.text(0.06, 0.06, f"Bounds violations dominate ({bd_pct['numeric_bounds']}%) — the decode grammar "
                             "doesn't constrain numbers. Grammar fix, not GPU training.",
                 color=OK, fontsize=15, alpha=a)


def executor_scene(t):
    clear()
    codes = list(ex["by_code"].items())[:8]
    ax = fig.add_axes([0.34, 0.13, 0.58, 0.64])
    ax.set_facecolor(BG)
    p = scene_progress(t, 28, 5)
    names = [c for c, _ in codes][::-1]
    vals = [n * p for _, n in codes][::-1]
    plumb = set(ex["plumbing_codes"])
    cols = [(DIM if c in plumb else ACCENT) for c in names]
    ax.barh(names, vals, color=cols)
    ax.set_xlim(0, codes[0][1] * 1.18)
    for s in ax.spines.values():
        s.set_color(DIM)
    ax.tick_params(colors=FG, labelsize=13)
    if p > 0.98:
        for i, (c, n) in enumerate(codes[::-1]):
            ax.text(n + codes[0][1] * 0.01, i, f"{n:,}", va="center", color=FG, fontsize=13)
    fig.text(0.06, 0.86, "And when the world refuses the action?", color=FG, fontsize=24, weight="bold")
    fig.text(0.06, 0.79, f"{ex['action_failed_total']:,} ActionFailed events, top codes",
             color=DIM, fontsize=16)
    if t > 40:
        a = scene_progress(t, 40, 2)
        fig.text(0.06, 0.06, f"Only {ex['plumbing_pct']}% is plumbing ({ex['plumbing']:,} events, grey) — "
                             f"{ex['substantive']:,} are the world honestly saying no.",
                 color=OK, fontsize=15, alpha=a)


def takeaway_scene(t):
    clear()
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    a1 = scene_progress(t, 50, 2)
    ax.text(0.5, 0.72, "Verb selection was never the problem.", ha="center",
            color=FG, fontsize=28, weight="bold", alpha=a1)
    lines = [
        (f"{dec['invalid_verbs']} invalid verbs in {dec['total']:,} decisions", OK, 54),
        (f"{bd_pct['numeric_bounds']}% of malformed = numeric bounds — grammar-fixable for free", WARN, 57),
        (f"executor plumbing noise: {ex['plumbing_pct']}%", DIM, 60),
    ]
    for i, (txt, col, t0) in enumerate(lines):
        a = scene_progress(t, t0, 1.5)
        ax.text(0.5, 0.52 - i * 0.10, txt, ha="center", color=col, fontsize=19, alpha=a)
    ax.text(0.5, 0.10, "every number: demos/failure-taxonomy-corpus/metrics.json",
            ha="center", color=DIM, fontsize=11)


def draw(frame):
    t = frame / FPS
    if t < 8:
        title_scene(t)
    elif t < 28:
        decision_scene(t)
    elif t < 50:
        executor_scene(t)
    else:
        takeaway_scene(t)
    return []


anim = animation.FuncAnimation(fig, draw, frames=FRAMES, blit=False)
out = HERE / "out.mp4"
anim.save(str(out), writer=animation.FFMpegWriter(fps=FPS, bitrate=2400))
print("wrote", out)
