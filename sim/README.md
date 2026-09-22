# The levelling race

A simulated levelling race. Bots roll a Shaman, pick their own talents as they
go, and grind to 60 — and the talents they picked are what decides who wins.

Nothing here talks to the real game. It is a toy, and the only thing it is
trying to be is *worth watching*.

```
node sim/server.js                         watch it at localhost:5503/sim/
node sim/run.js                            or run one headless and print the table
node sim/run.js --bots 40 --hardcore       death is permanent
node sim/run.js --seed 7                   the same seed is the same race
node sim/test.js                           71 assertions
```

## Watching it

Four views across the top:

| | |
|---|---|
| **The race** | level-over-time chart, leaderboard, live feed |
| **Profiles** | a card per bot: who they are, top talents, what their build is worth |
| **Analysis** | split times by build, and what the field is picking |
| **Past races** | who won, and in how long |


`sim/server.js` keeps one race running and serves the page at `/sim/`. When
everyone has finished or died it pauses briefly and starts another, so it can be
left running and there is always something happening.

The leaderboard shows where each bot is **now**, including the spec they have
built up so far rather than the one they are heading for — watching someone
commit to a tree is half the interest, and showing the finished build would give
the plan away.

Click a bot for their XP bar and how long the next level will take, their three
talent trees drawn as trees, and what the build is actually worth. **Open this
build in the calculator** hands it to the real page as a share code, at the
level they are at now rather than the finished article.

`#profiles` or `#race/Gorbeard` links straight to a view or a bot.

### The four stats are shown as what they buy

`power`, `sustain`, `defense` and `aoe` are model numbers and mean nothing on
their own, so the bot panel translates them: kill speed, the share of time sat
drinking, deaths an hour, and one headline — how much faster this build levels
than the same character with nothing spent at all. Hover anything for the
tooltip; talents show their real rank text from the edition data.

### Who the bots are

Faction, race, gender and names come from
[`config/roster.json`](config/roster.json). The class/race table in there is
**vanilla's** — Forever is not obliged to keep it, and if it differs that file
is the only thing to change. Nothing is hard-coded: adding `"Shaman"` to Dwarf
is all it takes to see Dwarf Shamans race. Names are built from per-race
syllables, so an Orc sounds like an Orc and a field of thirty never repeats.

| | |
|---|---|
| `SIM_SPEED` | sim minutes per real second (default 1, so a race lasts about 10 hours) |
| `SIM_BOTS` | how many race (default 30) |
| `SIM_HARDCORE` | `1` for permanent death |
| `SIM_CALC_BASE` | where the calculator lives (default `/`) |
| `BASE_PATH` | where the sim is mounted (default `/sim`) |

## Why the talents are the point

A bot is not fast because it got a good seed. Every talent carries a weight in
[`weights/shaman.json`](weights/shaman.json) across four stats:

| stat | what it buys |
|---|---|
| `power` | things die faster |
| `sustain` | less time sat drinking |
| `defense` | fights go wrong less often |
| `aoe` | pull three instead of one |

Those four feed the rate formula in [`engine.js`](engine.js), so a Shaman who
went deep Enhancement really does out-level one who spread points around, and
the finishing order tracks the builds rather than the dice.

The weights are **judgement calls read off the tooltips**, not measured values.
They are in a data file precisely so they can be argued with: change a number,
re-run, see whether a different build wins.

### Power and sustain are substitutes

Worth knowing before you retune anything. In the current numbers, `power` and
`sustain` each correlate only weakly with finishing time on their own, because
they are two routes to the same place — Enhancement kills fast, Restoration
barely stops to drink, and they finish within a few hours of each other. What
predicts the result is the *combination*, which `run.js` reports as `buildRate`
(about −0.44, where −1 would mean the build decided everything and 0 that it
decided nothing).

If you push that toward −1 the race becomes a procession in build order. Toward
0 and it stops mattering what anyone picked. The dials are all at the top of
`engine.js`.

## How a bot chooses

Bots are handed a personality, not a build: weights over the four stats, a
favourite tree, a `focus` (how strictly they follow their own plan), plus how
many hours a day they play, when, and how recklessly.

Recklessness is the interesting one — it buys speed and costs safety, which is
why two bots with near-identical builds can finish a day apart, and why hardcore
is not simply the same race with a harsher penalty.

They then pick, one point at a time, from whatever is **legal at that moment**
under the same tier and prerequisite rules the calculator uses. So a route is
always a real build: `sim/test.js` checks that, and a browser probe has
confirmed the page itself accepts every step with zero refusals.

## Hardcore

`--hardcore` makes death elimination. It needs its own death rate
(`hardcoreDeathScale`), because "annoying corpse run" and "character over" are
not the same event with different stakes — people play the second one far more
carefully, and the model says so.

Danger also ramps in over the first twenty levels, so nobody dies at level 2 and
the losses cluster where they are actually dramatic. Currently about a quarter
of the field reaches 60.

## Why a database and not a formula

The first design made the whole race a pure function of `(seed, elapsed)` — no
process, no state, scrub anywhere. It had a fatal flaw: retuning the model at
hour 40 silently rewrote hours 0–39, so everyone's history changed underneath
them.

So `events` is append-only and is the record of what happened. Retune mid-race
and the past stays as it was lived; only what happens next changes.
`bot_state` is a cache of folding those events, kept so the leaderboard is one
query.

A race is resumable: stop the process, redeploy, carry on from the minute it
reached. The RNG stream is *not* replayed on resume, so a stopped-and-restarted
race diverges from one that ran straight through. That is fine, and deliberate —
the events already written are what happened.

## Files

| file | |
|---|---|
| `rules.js` | tier and prerequisite rules, lifted from `src/template.html` |
| `routes.js` | personalities, and picking talents from them |
| `weights/shaman.json` | what each talent is worth to a leveller |
| `stats.js` | build → the four stats |
| `xp.js` | the levelling curve |
| `engine.js` | the tick, and every tuning dial |
| `db.js` | schema |
| `race.js` | creating, loading and advancing a race |
| `roster.js` + `config/roster.json` | faction, race, gender and names |
| `share.js` | build → a share code the calculator accepts |
| `run.js` | run one headless and print the result |
| `server.js` | the tick loop, and the JSON API |
| `public/watch.html` | the page |

## Known approximations

- **The XP curve** uses the vanilla shape `(8 × L) × (45 + 5 × L)`, which gives
  the correct 400 xp for level 1→2, but omits the level-28+ adjustments. The
  total is calibrated by a `SCALE` constant so an average bot finishes in a
  believable number of hours played, rather than by guessing at constants. Drop
  the exact per-level table into `xp.js` and set `SCALE` to 1 if it ever
  matters; nothing else reads those numbers.
- **Shaman only.** Every other class needs a `weights/<class>.json`; `stats.js`
  throws a clear error until one exists.
- **No gear, no quests, no zones.** Grinding only.
- **Speed below ten needs the tick banker.** A race advances in whole
  ten-minute ticks, so `server.js` accumulates fractional minutes and only
  spends whole ticks. Without that, any `SIM_SPEED` under 10 quietly ran at 10.
