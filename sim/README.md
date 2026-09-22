# The levelling race

A simulated levelling race. Bots roll a character of any class and race, pick
their own talents as they go, and grind to 60 — and the talents they picked are
what decides who wins.

Nothing here talks to the real game. It is a toy, and the only thing it is
trying to be is *worth watching*.

```
node sim/server.js                         watch it at localhost:5503/sim/
node sim/run.js                            or run one headless and print the table
node sim/run.js --bots 40 --hardcore       death is permanent
node sim/run.js --seed 7                   the same seed is the same race
node sim/test.js                           97 assertions
```

## Changing it

Two files, no code:

| | |
|---|---|
| [`config/race.json`](config/race.json) | how many bots, which classes, speed, hardcore |
| [`config/roster.json`](config/roster.json) | which races and factions exist, and which classes each race may take |

Edit and restart. An environment variable of the same name overrides the file
(`SIM_BOTS`, `SIM_CLASS`, `SIM_SPEED`, `SIM_HARDCORE`, `SIM_INTERMISSION`,
`SIM_EDITION`), so a deployment can differ without the file being edited - but
if you are just running it, the file is the place.

The sim prints what it settled on at startup, so a puzzling race is one log line
away from explained:

```
  30 bots · 9 classes · 1 sim-min/sec · normal · forever
```

### More bots

```json
"bots": 60
```

### Only some classes

```json
"classes": ["Paladin", "Shaman"]
```

Worth knowing: in vanilla's table that one is Alliance against Horde, because
Paladin is Alliance-only and Shaman Horde-only. `"*"` means every class, which
is the only way to get a properly mixed field.

### A new race, or a class a race should not have

`roster.json`. Adding `"Shaman"` to Dwarf's `classes` is all it takes to see
Dwarf Shamans in the next race; the sim derives everything else from that.
A new race needs a faction, an icon name (Wowhead's, without the `_male` /
`_female` suffix), its class list, and head/tail syllables for names.

The keys beginning `/` are comments. JSON has no comment syntax and the reader
ignores them - but note they must stay *unique*, because a duplicate key is
silently dropped by any tool that rewrites the file.

## Watching it

Four views across the top:

| | |
|---|---|
| **The race** | level-over-time chart, leaderboard, live feed |
| **Profiles** | a card per bot: who they are, top talents, what their build is worth |
| **Analysis** | split times by build, and what the field is picking |
| **Past races** | every finished race, redrawn in full |


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

### When somebody hits 60

A bell in the top right lights, counts, and plays a short fanfare. Clicking it
gives the roll of honour with times, and clicking a name jumps to that bot. The
note button mutes it, remembered per browser.

The fanfare is synthesised rather than shipped: no audio file to serve, nothing
fetched, nothing a content policy can block. Browsers refuse to start audio
before the page has been clicked, so the first one may be silent - that is the
browser, not a fault.

### Hovers

Tooltips carry the page's real data rather than a line of prose:

- **a bot's name or crests** &mdash; the whole character: faction, race and class
  icons, level, hours played, deaths, points, whether they are at the keyboard,
  their spec split drawn out, and what the build is worth
- **any talent icon** &mdash; its own icon, which spec and tier it sits in, the
  rank held, what that rank actually does (the real text from the edition data),
  and what the next rank would add
- **a spec bar** &mdash; points per spec against points earned
- **a stat** &mdash; what it buys, not what it is called

### Two clocks, and which one the table uses

The leaderboard orders finishers **first past the post, by the race clock** -
not by hours played. Somebody who plays fourteen hours a day can cross the line
before somebody who played fewer hours in total, which reads as a mistake until
you know it. The `Played` column is hours at the keyboard, and the sort control
beside the search box switches between them. The finishing position never
renumbers when you re-sort.

The analysis panel uses the second clock throughout: a split time is hours
*played* to reach a level, so it measures the build rather than the schedule.

### Past races

Any finished race can be reopened and gets the same treatment as the live one:
the level-over-time chart, the full final standings with identity, specs and
talents, split times by class, and every bot's build openable in the calculator.
It is rebuilt from the database rather than stored twice - the `bots` table
keeps each route and personality, so reloading reproduces exactly the field that
ran. `#history/r0003/Brybeard` links to one bot of one past race.

### Finding someone

The leaderboard has a search box that matches name, class, race, faction and
spec at once. Every word has to match, so `troll shaman` narrows rather than
widening the way an OR would. `online only` hides anyone away from the keyboard,
and both keep the bot's real standing in the full field rather than renumbering.

### Who the bots are

Faction, race, gender and names come from
[`config/roster.json`](config/roster.json). The class/race table in there is
**vanilla's** — Forever is not obliged to keep it, and if it differs that file
is the only thing to change. Nothing is hard-coded: adding `"Shaman"` to Dwarf
is all it takes to see Dwarf Shamans race. Names are built from per-race
syllables, so an Orc sounds like an Orc and a field of thirty never repeats.

A race is mixed-class by default, which is the only way both factions appear:
no single class is open to all eight races. With all nine classes on offer the
two factions have twenty legal race/class pairs each, so the field comes out
even without anything weighting it.

## The weights, and an honest warning about them

`weights/shaman.json` is **hand-written**: every talent read off its tooltip and
given a judgement. The other eight are **drafted** by
[`tools/draft-weights.js`](../tools/draft-weights.js), which matches the rank
text against a keyword table and scales by whatever percentage the tooltip
quotes. That gets the shape right and the detail wrong.

```
node tools/draft-weights.js               draft any class that has none
node tools/draft-weights.js Mage --force  redraft one
```

`--force` will not touch a hand-written file; that needs
`--clobber-handwritten`, because a hand-written file is work the tool cannot
reproduce. Drop the `_derived` flag from a file once you have gone over it and
the drafter leaves it alone from then on.

### Why they are normalised

The first draft made the generator decide the race. The drafted classes came
out on a hotter scale than the hand-tuned Shaman - roughly twice the power pool
- so they simply out-levelled it, and "which class is winning" was measuring my
keyword table rather than the talents. Druid reached 50 in 41h against Shaman's
86h, which was noise wearing a result's clothes.

Every class is now scaled so its total pool of each stat matches the reference.
What is left to differ is the *shape*: how that pool is spread across the three
trees, and so what a bot picking greedily ends up holding. The spread across a
36-bot field came back to 89h-120h, with Shaman mid-field.

This is still the weakest part of the model. Treat a class result as a
hypothesis, not a finding, until that class's weights have been gone over by
hand.

| | |
|---|---|
| `SIM_SPEED` | sim minutes per real second (default 1, so a race lasts about 10 hours) |
| `SIM_BOTS` | how many race (default 30) |
| `SIM_HARDCORE` | `1` for permanent death |
| `SIM_CLASS` | `*` for every class (default), or a comma-separated list |

All of those default from `config/race.json` rather than from the code.
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

### Why the table holds still

Split times only change when the field crosses a new level, so between
milestones the numbers are genuinely frozen - which reads as broken. The panel
therefore also shows the climb toward the next milestone, which does tick along,
and stamps the race time it last looked at. Average level keeps moving
throughout.

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
| `config/race.json` | how a race is set up |
| `roster.js` + `config/roster.json` | faction, race, gender and names |
| `../tools/draft-weights.js` | first-pass weights for a class, from the tooltips |
| `share.js` | build → a share code the calculator accepts |
| `run.js` | run one headless and print the result |
| `server.js` | the tick loop, and the JSON API |
| `public/watch.html` | the page |

## Known approximations

- ~~The XP curve is approximate~~ — **fixed**. It is now the real vanilla
  curve, `round100((8L + Diff(L)) × (45 + 5L))`, which reproduces all twelve
  published values and totals the published 4,084,700. Note the published rest
  factor does *not* apply to the level table: applying it puts level 20 at
  20,900 against the real 23,200. A full climb takes a bot 230–310 hours
  played, which is where vanilla actually sat.
- **Only Shaman's weights are hand-written.** The other eight are drafted and
  normalised; see above.
- **No gear, no quests, no zones.** Grinding only.
- **Speed below ten needs the tick banker.** A race advances in whole
  ten-minute ticks, so `server.js` accumulates fractional minutes and only
  spends whole ticks. Without that, any `SIM_SPEED` under 10 quietly ran at 10.
