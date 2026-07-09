# M2 Demo — the village elects a mayor, filmable run-through

Twenty villagers hold the village's first election. The operator opens it —
one REST call, the single seeded act — and everything after is organic:
candidacies declared mid-deliberation, campaign chatter colored by real
memories and grudges, votes cast with stated reasons, a mayor seated by a
plurality clock. Every step is a ledger event with a causation chain back to
the deliberation that chose it. This is the Episode 2 shot script and the
regression baseline for M2's Definition of Done.

## Prerequisites (once)

- Everything from `docs/demo-m1.md` (Docker Desktop, Ollama with
  `llama3.1:8b` + `nomic-embed-text`).
- **Do NOT set `OPENAI_API_KEY` yet**: the decision schema's free-form world
  `params` violates OpenAI strict-mode structural rules (latent since M1-3,
  diagnosed in M2-7) — with a key present every deliberation 400s. Ollama is
  the proven preset; the params reshape is a pre-OpenAI-run fix.
- `.env` filming preset: `VILLAGER_COUNT=20`, `TICK_INTERVAL_SECONDS=60`,
  `MC_HOST=minecraft`, `LLM_DAILY_TOKEN_BUDGET=100000000` (Ollama sizing),
  `REFLECTION_ENABLED=true`.

## The run

```sh
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
  --profile infra --profile app --profile minecraft up -d --build --wait
# --build matters: agent-service must carry M2-3 prompts + M2-7 schema +
# M2-8 civics; government-service and event-service ship the election
# machinery and the two governance topics.
task seed                                # idempotent; re-embodies any missing bots
npm run dev --workspace @civ/dashboard   # dashboard on :3000
```

Let the village warm up for 2–3 ticks (~3 minutes) so villagers are mid-life,
not mid-boot, when the announcement lands. **Open elections only while
agent-service is up** — its civic memory is in-process; a restart mid-election
forgets the campaign (the ledger keeps everything, the minds do not).

## The one seeded act (on camera)

```sh
curl -X POST http://localhost:8082/elections -H 'Content-Type: application/json' -d '{}'
```

That is the entire operator input (M2 DoD #1 allows nothing more). Defaults:
office `mayor`, nominations open immediately for 10 minutes, voting for 15 —
sized so every villager deliberates ~10 times per window at the 60s tick.
Window overrides go in the body (`nominatingWindowSeconds`,
`votingWindowSeconds`) or `.env` (`ELECTION_NOMINATING_WINDOW_SECONDS`,
`ELECTION_VOTING_WINDOW_SECONDS`).

Within one tick, every villager's prompt gains the standing **VILLAGE
AFFAIRS** section — nominations first (declare_candidacy affordance), then
voting (the vote affordance with the candidate list and platforms). Percepts
announce each candidacy and the final result to everyone; rejections
(`ALREADY_VOTED`, `WINDOW_CLOSED`…) go only to the villager who earned them.

## The money shots (Episode 2 shot list)

**Shot 1 — the announcement.** `/government` page on screen (empty state:
"No election has ever been called"). Run the POST on camera; the election
card appears with the phase chip and the countdown. In-game, villagers start
mentioning the election in chat within a tick or two.

**Shot 2 — someone steps forward.** The candidate list fills in organically —
name + platform in the villager's own words. The receipts panel is still
empty; the tension is who runs. Ledger receipt, live:

```sh
curl "http://localhost:8081/events?type=CandidateNominated"
# causationId -> the GovernanceRequested command -> its causationId -> the
# DecisionMade that chose to run. Read the platform aloud.
```

**Shot 3 — campaign chatter.** Dashboard live feed + in-game: chat colored
by the campaign ("Bram has my vote — he shared his bread"). The single-call
tick means a villager can campaign AND act in the same breath — watch for
chat+vote and move+vote decisions in the feed.

**Shot 4 — the ballots, with reasons.** `/government`'s receipts panel while
voting runs: every ballot lands with the voter's own why, newest first. The
tally bars move live (SSE). This is the campaign's evidence locker.

**Shot 5 — the double vote that wasn't.** Someone re-votes eventually (or
force one after the arc with `node scripts/produce-gov-cmd.mjs <voterId>
vote '{"electionId":"<id>","candidateVillagerId":"<otherId>"}'`): the tally
does NOT move, and the ledger shows `GovernanceRejected{ALREADY_VOTED}` —
"the first vote stands" (DoD #3, on camera-day data).

```sh
curl "http://localhost:8081/events?type=GovernanceRejected"
```

**Shot 6 — election night.** The countdown hits zero on `/government`; the
chip flips to `decided`, the winner banner lands, ★ mayor. In-game, the new
mayor's next prompts carry "You are the mayor of the village" — their first
mayoral address is ordinary chat, colored by the office (physics, not
script). Everyone else perceives "the votes are counted: X is the new mayor".

**Shot 7 — why did she vote that way?** Pick any vote off the receipts panel
and replay its mind (DoD #2):

```sh
curl "http://localhost:8081/events?type=VoteCast"                 # pick one, note causationId
curl "http://localhost:8081/events/<causationId>"                 # the GovernanceRequested command
curl "http://localhost:8081/events/<its-causationId>"             # the DecisionMade: reasoning field
curl "http://localhost:8081/events?correlation-id=<correlationId>" # the whole tick, incl. MemoryFormed
```

The DecisionMade's `reasoning` names the memories and feelings that moved
the vote — the "why did Yara vote against Bram" replay, straight from an
append-only ledger.

## Steering levers (staged, use ONLY if the arc stalls)

The politics must stay organic; these are nudges, not scripts:

- **`COMMUNITY_GOAL`** (env on agent-service, blank = off): one system-prompt
  line — "The village talk lately keeps returning to one shared aim: …".
  Example: `COMMUNITY_GOAL="the village needs a proper granary before winter"`
  gives the campaign a concrete issue. Restart agent-service to apply
  (`up -d agent-service` after exporting; container env is baked at create).
  NOTE: a restart forgets a mid-flight election — pull this lever BEFORE
  opening the election, never during.
- **Influencer personas** (zero code): `seed/villagers.json` edits — give one
  or two villagers civic-flavored traits/backstory ("believes the village
  needs a steady hand at the ledger") and reseed a fresh world. The founding
  three and file ORDER are contract; append-side edits only.
- **Window sizing**: slower drama → longer windows via the POST body. The
  budget math: 20 villagers × 60s ticks × 25 min ≈ 500 deliberations ≈ 200k
  tokens on llama (free) — windows are cheap.

## Health during filming

```sh
docker exec ai-civilization-engine-minecraft-1 rcon-cli mspt    # avg < 50
docker exec ai-civilization-engine-minecraft-1 rcon-cli list    # 20/20 online
curl -s localhost:8001/metrics | grep -E "civ_llm_(malformed|governance_dropped)_total"
curl -s localhost:8082/actuator/prometheus | grep civ_governance_commands_total
docker logs ai-civilization-engine-government-service-1 --tail 20 | grep -E "vote cast|candidacy|rejected"
```

## Teardown

```sh
task down        # volumes survive — the election is canon now
```
