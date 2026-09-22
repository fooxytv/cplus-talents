# Feeding a real race in

The page draws a race, not a simulation. A race of real characters is the same
shape as a simulated one, so tracking one needs no new front end — it needs a
way in, and that is [`ingest.js`](ingest.js).

Turn it on with a key. **No key, no writes**: this serves on a public hostname,
and an open endpoint would let anybody invent a race.

```bash
SIM_INGEST_KEY=$(openssl rand -hex 24)
```

## The rule everything follows

An **observation** is a fact about a reading — *"at 14:02 this source said Bella
was level 23"*. An **event** is our reading of it — *"Bella reached 23"*.
Observations are kept verbatim and forever; events are derived from them.

Keeping both is what makes a source that lags, lies or contradicts another
visible instead of silently rewriting the race. A level that goes backwards is
recorded and then **ignored**: a race that can run backwards is worse than one
that is briefly wrong.

## What it cannot do, and does not pretend to

- **There is no `/played`.** Blizzard's profile API does not expose time played,
  so a real character carries `played_known = 0` and split times fall back to
  wall clock. The page should say which it is showing rather than quietly mixing
  them.
- **An armory only updates on logout.** A reading is a lower bound with an
  unknown lag, never "the level right now". `/provenance` reports how stale the
  newest reading for each character is, which is the number that says whether a
  standing is worth believing.
- **A reading dated ahead of the clock** is flagged as `future`, not reported as
  a negative age — it means a clock is wrong somewhere.

## Endpoints

All writes are `POST`, all need `X-Ingest-Key` (or `?key=`).

```bash
# start a race that tracks real characters
curl -X POST -H "X-Ingest-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"id":"launch","name":"Forever launch","startedAt":"2026-11-04T23:00:00Z"}' \
  https://talents.fooxy.tv/sim/api/ingest/race

# add somebody
curl -X POST -H "X-Ingest-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"raceId":"launch","name":"Bella","klass":"Druid","race":"Night Elf",
       "faction":"Alliance","realm":"Wild Growth","region":"us","source":"armory"}' \
  https://talents.fooxy.tv/sim/api/ingest/character

# one reading, or a batch — a bad row fails on its own without losing the rest
curl -X POST -H "X-Ingest-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"raceId":"launch","observations":[
        {"botId":"Bella","source":"armory","level":18,"observedAt":"2026-11-05T04:00:00Z"},
        {"botId":"Thrallgar","source":"armory","level":22}]}' \
  https://talents.fooxy.tv/sim/api/ingest
```

An observation may carry `level`, `xp` + `xpMax`, `played`, `talents`, a `note`,
and the untouched `raw` payload the source gave you. Everything is optional
except `botId` and `source`; `source` must be one of `manual`, `armory`,
`addon`, `sim`.

Reading back needs no key — it only ever describes the data:

```
GET /sim/api/race/launch              the race, same shape as a simulated one
GET /sim/api/race/launch/provenance   where the numbers came from, and how old
```

## Talents

Send them as a flat map of talent to rank — that is what any source can
actually give:

```json
{"botId":"Bella","source":"armory","level":34,
 "talents":{"Improved Wrath":5,"Nature's Grasp":1}}
```

They are walked into a legal order so a real character's build renders exactly
like a bot's, and opens in the calculator the same way. **A build that cannot
legally be reached is flagged rather than stored as fact** — a `note` event
records what was asked for and what was reachable.

## What is not built yet

The adapters. `ingest.js` accepts readings; something still has to go and get
them. An armory poller is the obvious first one, and cannot be written against
Forever until Forever is in an API.
