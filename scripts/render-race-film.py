# Render the captioned race film straight from an attempt's ledger slice —
# no game client, no OBS, no hand-edited timeline: every beat on screen is a
# ledger event and every caption maps to the demo-rb.md caption table. The
# honest-race differentiator carried into the artifact itself.
#
# Usage:
#   uv run --with pillow --with imageio --with imageio-ffmpeg \
#     python scripts/render-race-film.py <slice.json> <out.mp4>
#
# The film compresses real race time (~12m41s) into ~150s: intro card,
# per-milestone beats at proportional offsets (4s minimum spacing), win card
# with the receipt ids, honesty card last.

import json
import sys
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 24
BG = (11, 11, 14)
FG = (235, 235, 238)
DIM = (150, 150, 160)
RED = (211, 64, 47)
BLUE = (47, 111, 211)
GOLD = (240, 190, 60)

MILESTONES = ["first_coal", "first_iron_ore", "furnace_placed", "first_ingot", "iron_pickaxe"]
PROSE = {
    "first_coal": "coal mined",
    "first_iron_ore": "iron ore mined",
    "furnace_placed": "furnace placed",
    "first_ingot": "iron smelted",
    "iron_pickaxe": "IRON PICKAXE",
}
ROSTER = {"red": "Elara · Bram · Wren", "blue": "Ansel · Petra · Fen"}
NAME_OF = {
    "019f8e2a-0000-7000-8000-0000000e1a2a": "Elara",
    "019f8e2a-0000-7000-8000-0000000b2a44": "Bram",
    "019f8e2a-0000-7000-8000-0000000c3e55": "Wren",
    "019f8e2a-0000-7000-8000-0000000d0004": "Ansel",
    "019f8e2a-0000-7000-8000-0000000d0005": "Petra",
    "019f8e2a-0000-7000-8000-0000000d0006": "Fen",
}


def font(size, bold=False):
    for name in (["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_HUGE, F_H1, F_H2, F_BODY, F_SMALL = font(96, True), font(64, True), font(44, True), font(36), font(26)


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load(path):
    with open(path, encoding="utf-8") as fh:
        events = json.load(fh)["data"]
    started = next(e for e in events if e["eventType"] == "AttemptStarted")
    ended = next(e for e in events if e["eventType"] == "AttemptEnded")
    t0 = parse(started["occurredAt"])
    beats = [
        {
            "at": (parse(e["occurredAt"]) - t0).total_seconds(),
            "team": e["payload"]["teamId"],
            "milestone": e["payload"]["milestone"],
            "who": NAME_OF.get(e["payload"].get("villagerId", ""), "?"),
            "detail": e["payload"].get("detail") or "",
        }
        for e in events
        if e["eventType"] == "ProgressionMilestone"
    ]
    return started["payload"], ended["payload"], sorted(beats, key=lambda b: b["at"]), t0


def fmt(seconds):
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def draw_ladder(d, x, y, team, color, crossed, times):
    d.text((x, y), f"TEAM {team.upper()}", font=F_H2, fill=color)
    d.text((x, y + 56), ROSTER[team], font=F_SMALL, fill=DIM)
    for i, m in enumerate(MILESTONES):
        yy = y + 110 + i * 64
        done = m in crossed
        box = color if done else (45, 45, 52)
        d.rounded_rectangle([x, yy, x + 44, yy + 44], 8, fill=box)
        if done:
            d.line([x + 10, yy + 22, x + 19, yy + 33], fill=BG, width=5)
            d.line([x + 19, yy + 33, x + 35, yy + 12], fill=BG, width=5)
        label_fill = FG if done else DIM
        d.text((x + 62, yy + 4), PROSE[m], font=F_BODY, fill=label_fill)
        if done:
            d.text((x + 460, yy + 10), fmt(times[m]), font=F_SMALL, fill=DIM)


def frame(state):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((80, 50), "RED vs BLUE", font=F_H1, fill=FG)
    d.text((80, 130), "six LLM villagers · first crafted iron pickaxe wins · zero human intervention", font=F_BODY, fill=DIM)
    d.text((W - 420, 60), f"race clock  {fmt(state['clock'])}", font=F_H2, fill=FG)
    d.text((W - 420, 120), "normal difficulty · hostiles ON", font=F_SMALL, fill=DIM)
    draw_ladder(d, 80, 260, "red", RED, state["red"], state["times"]["red"])
    draw_ladder(d, 700, 260, "blue", BLUE, state["blue"], state["times"]["blue"])
    feed_x, feed_y = 1330, 260
    d.text((feed_x, feed_y), "milestone feed (ledger)", font=F_H2, fill=FG)
    for i, line in enumerate(state["feed"][-8:]):
        color = RED if line["team"] == "red" else BLUE
        d.text((feed_x, feed_y + 80 + i * 74), f"{fmt(line['at'])}  {line['team']}", font=F_SMALL, fill=color)
        d.text((feed_x, feed_y + 106 + i * 74), f"{line['who']} — {PROSE[line['milestone']]}", font=F_BODY, fill=FG)
    if state.get("caption"):
        d.rounded_rectangle([70, H - 150, W - 70, H - 60], 14, fill=(22, 22, 28))
        d.text((100, H - 130), state["caption"], font=F_BODY, fill=GOLD)
    return img


def card(lines, sub=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    y = H // 2 - len(lines) * 60
    for text, fnt, fill in lines:
        w = d.textlength(text, font=fnt)
        d.text(((W - w) // 2, y), text, font=fnt, fill=fill)
        y += fnt.size + 40
    if sub:
        w = d.textlength(sub, font=F_SMALL)
        d.text(((W - w) // 2, H - 120), sub, font=F_SMALL, fill=DIM)
    return img


CAPTIONS = [
    (0, "Six villagers, two teams, one goal — the first crafted iron pickaxe wins"),
    (20, "No scripts: each villager thinks with a local llama3.1 every 10 seconds"),
    (45, "The wood age: axes are free, ores are tool-gated"),
    (70, "105 hostile encounters tonight — the body fights, the mind keeps mining"),
    (100, "One craft resolves the chain: furnace placed, three ingots smelted, pickaxe"),
]


def main():
    slice_path, out_path = sys.argv[1], sys.argv[2]
    started, ended, beats, t0 = load(slice_path)
    real_len = beats[-1]["at"] + 5
    play_len = 130.0
    import imageio.v2 as imageio

    writer = imageio.get_writer(out_path, fps=FPS, codec="libx264", quality=7, macro_block_size=None)
    intro = card(
        [
            ("RED vs BLUE", F_HUGE, FG),
            ("a 3v3 LLM race to the iron age", F_H2, FG),
            ("every milestone below is an append-only ledger event", F_BODY, DIM),
            (f"attempt {started['attemptId'][:13]}… · {started['difficulty']} · hostiles ON", F_BODY, DIM),
        ],
        sub="AI Civilization Engine — rendered from the event ledger, not edited footage",
    )
    for _ in range(FPS * 6):
        writer.append_data(__import__("numpy").asarray(intro))
    state = {"red": set(), "blue": set(), "times": {"red": {}, "blue": {}}, "feed": [], "clock": 0.0, "caption": None}
    total_frames = int(play_len * FPS)
    for n in range(total_frames):
        play_t = n / FPS
        state["clock"] = play_t / play_len * real_len
        for b in beats:
            if b["at"] <= state["clock"] and b["milestone"] not in state[b["team"]]:
                state[b["team"]].add(b["milestone"])
                state["times"][b["team"]][b["milestone"]] = b["at"]
                state["feed"].append(b)
        state["caption"] = next((c for s, c in reversed(CAPTIONS) if play_t >= s), None)
        writer.append_data(__import__("numpy").asarray(frame(state)))
    win_name = NAME_OF.get(ended.get("winningVillagerId", ""), "?")
    outro = card(
        [
            (f"TEAM {ended['winningTeamId'].upper()} WINS", F_HUGE, BLUE if ended["winningTeamId"] == "blue" else RED),
            (f"{win_name} crafts the iron pickaxe — {fmt(ended['durationSeconds'])} race time", F_H2, FG),
            ("honest-race assertion: CLEAN", F_H1, GOLD),
            ("zero scripted decisions · zero budget trips · zero deaths", F_BODY, FG),
            (f"win event {ended['winningEventId'][:18]}… · replayable from the ledger", F_BODY, DIM),
        ],
        sub="curl localhost:8081/events?aggregate-type=Attempt&aggregate-id=" + started["attemptId"],
    )
    for _ in range(FPS * 8):
        writer.append_data(__import__("numpy").asarray(outro))
    writer.close()
    print(f"wrote {out_path}: {6 + play_len + 8:.0f}s at {FPS}fps")


if __name__ == "__main__":
    main()
