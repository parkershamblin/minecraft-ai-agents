Read demos/STATUS.md. Pick the non-GREEN demo closest to GREEN whose stack
needs don't conflict with demos/.stack.lock (respect an existing lock; take it
before driving docker/Minecraft/Ollama, delete it after). Advance that demo
exactly one step toward its five done-criteria (run.sh, /verify observation,
metrics.json, capture.sh -> out.mp4, CAPTION.md), then /verify it. Update
STATUS.md with the result and the single next action. If a demo is blocked on
an owner decision, mark it BLOCKED with the question and move on — never park
on a question. If all five are GREEN: rerun each capture.sh once from a clean
checkout to confirm reproducibility, write demos/FINAL.md summarizing the five
artifacts, then report and stop the loop.
