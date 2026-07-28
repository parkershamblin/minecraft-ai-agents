"""Recompute the failure taxonomy from the committed bench windows.

Corpus: bench/results/sweep/slices/*.window.json (no containers, no new runs).
Plumbing-vs-substantive split: reuses _PLUMBING_CODES from
services/agent-service/src/agent_service/brain/awareness.py (imported, not copied).
Output: demos/failure-taxonomy-corpus/metrics.json
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SLICES = REPO / "bench" / "results" / "sweep" / "slices"
OUT = Path(__file__).resolve().parent / "metrics.json"

sys.path.insert(0, str(REPO / "services" / "agent-service" / "src"))
from agent_service.brain.awareness import _PLUMBING_CODES  # noqa: E402

BOUNDS_RE = re.compile(
    r"greater than the maximum|less than the minimum|greater than or equal|"
    r"less than or equal|maximum of|minimum of|out of range|exceeds the maximum",
    re.I,
)
NOTJSON_RE = re.compile(
    r"not valid JSON|Expecting value|Invalid JSON|JSONDecodeError|Unterminated|"
    r"Expecting property name|Extra data|empty completion|no JSON",
    re.I,
)
PARAMS_RE = re.compile(
    r"is not of type|required propert|additional propert|is not one of|"
    r"does not match|is not valid under any of the given schemas|params invalid for",
    re.I,
)


def iter_events(doc):
    """Yield event dicts from whatever container shape the window file uses."""
    if isinstance(doc, list):
        yield from (e for e in doc if isinstance(e, dict))
    elif isinstance(doc, dict):
        for key in ("data", "events", "window", "rows", "items"):
            if isinstance(doc.get(key), list):
                yield from (e for e in doc[key] if isinstance(e, dict))
                return
        # dict of lists fallback
        for v in doc.values():
            if isinstance(v, list) and v and isinstance(v[0], dict) and "type" in v[0]:
                yield from v


def etype(e):
    return e.get("type") or e.get("eventType") or ""


def main():
    files = sorted(SLICES.glob("*.window.json"))
    if not files:
        sys.exit(f"no window files under {SLICES}")

    decisions = 0
    decision_errors = 0
    err_classes = Counter()
    unclassified_samples = []
    verbs = Counter()
    invalid_verbs = 0
    action_failed = Counter()
    action_failed_total = 0

    known_verbs = {
        "move", "gather", "chat", "follow", "idle", "craft", "hunt",
        "spawn", "despawn", "declare_candidacy", "vote",
    }

    for f in files:
        doc = json.loads(f.read_text(encoding="utf-8"))
        for e in iter_events(doc):
            t = etype(e)
            p = e.get("payload") or {}
            if t == "DecisionMade":
                decisions += 1
                dec = p.get("decision")
                if isinstance(dec, str) and dec:
                    verb = dec.split(None, 1)[0]
                elif isinstance(dec, dict):
                    verb = dec.get("action")
                else:
                    verb = None
                if isinstance(verb, str):
                    verbs[verb] += 1
                    if verb not in known_verbs:
                        invalid_verbs += 1
                if p.get("error") is True:
                    decision_errors += 1
                    reason = str(p.get("reasoning") or "")
                    if BOUNDS_RE.search(reason):
                        err_classes["numeric_bounds"] += 1
                    elif NOTJSON_RE.search(reason):
                        err_classes["not_json"] += 1
                    elif PARAMS_RE.search(reason):
                        err_classes["params_shape"] += 1
                    else:
                        err_classes["other"] += 1
                        if len(unclassified_samples) < 8:
                            unclassified_samples.append(reason[:200])
            elif t == "ActionFailed":
                action_failed_total += 1
                code = str(p.get("errorCode") or p.get("code") or "UNKNOWN")
                action_failed[code] += 1

    plumbing = sum(n for c, n in action_failed.items() if c in _PLUMBING_CODES)
    substantive = action_failed_total - plumbing

    metrics = {
        "corpus": {
            "files": len(files),
            "source": "bench/results/sweep/slices/*.window.json",
        },
        "decisions": {
            "total": decisions,
            "malformed": decision_errors,
            "malformed_pct": round(100 * decision_errors / decisions, 1) if decisions else None,
            "malformed_breakdown": dict(err_classes),
            "malformed_breakdown_pct": {
                k: round(100 * v / decision_errors, 1) for k, v in err_classes.items()
            } if decision_errors else {},
            "invalid_verbs": invalid_verbs,
            "verb_counts": dict(verbs.most_common()),
        },
        "executor": {
            "action_failed_total": action_failed_total,
            "by_code": dict(action_failed.most_common()),
            "plumbing_codes": sorted(_PLUMBING_CODES),
            "plumbing": plumbing,
            "substantive": substantive,
            "plumbing_pct": round(100 * plumbing / action_failed_total, 1) if action_failed_total else None,
        },
    }
    OUT.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in metrics.items() if k != "decisions"} |
                     {"decisions": {kk: vv for kk, vv in metrics["decisions"].items() if kk != "verb_counts"}},
                     indent=2))
    if unclassified_samples:
        print("\nUNCLASSIFIED SAMPLES:")
        for s in unclassified_samples:
            print(" -", s)


if __name__ == "__main__":
    main()
