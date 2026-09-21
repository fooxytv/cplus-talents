# CPlus Talents — the in-game addon

Takes a build from the calculator and spends the points for you.

> **Not tested in a live client.** It is written against the documented API and
> covered by 36 tests plus a round-trip check against the real page, but nobody
> has yet run it in World of Warcraft. Read the safety notes before using it on a
> character whose respec you would mind paying for.

## Installing

Copy the `CPlusTalents` folder into your AddOns directory:

```
World of Warcraft/_classic_/Interface/AddOns/CPlusTalents/
    CPlusTalents.toc
    CPlusTalents.lua
```

Then `/reload`, or restart the client. `/cplus` opens the window.

## Using it

1. Build something in the calculator, then press **For game**. That copies a
   string like:

   ```
   cpt1|forever|WARRIOR|Fury 31/20|Booming Voice=5,Cruelty=5,...
   ```

2. In game: `/cplus import`, paste, **Save loadout**.
3. `/cplus` to open the window, `<` and `>` to pick a loadout, and it shows
   exactly what it would spend.
4. **Apply** spends the points.

Loadouts are saved per character, so each alt keeps its own list.

| Command | Does |
| --- | --- |
| `/cplus` | Open or close the window |
| `/cplus import` | Paste a build from the calculator |
| `/cplus list` | Print saved loadouts to chat |
| `/cplus help` | The above |

## Why it is built the way it is

**Talents travel by name, not by position.** The export carries
`Booming Voice=5`, not "the fourth talent in tab two". Every name is looked up
with `GetTalentInfo` at apply time, so the addon cannot put points into the wrong
talent because the site's tree order differs from your client's. A build naming a
talent your character does not have is refused outright.

**Nothing is spent until you press Apply**, and then one point at a time. After
each `LearnTalent` the addon re-reads the rank from the client rather than
trusting its own count — if the client refuses for any reason, it stops there and
says how far it got, instead of looping.

**Any problem stops the whole thing before the first point.** Wrong class, a
missing talent, more ranks than exist, not enough points, or a talent already
ranked higher than the build wants — all of them refuse the apply rather than
doing half of it.

**It never unlearns.** If a talent already has more points than the build asks
for, that is reported as a problem. Removing points means a full respec, which
costs gold, so the addon will not start one on your behalf.

## Tests

```bash
lua addon/test-addon.lua        # 36 assertions against a stubbed client
node addon/test-roundtrip.js    # the real page's export, parsed by the real addon
```

The stub fakes a small talent tree, a class, a point pool and a `LearnTalent`
that refuses in combat, past `maxRank` and with no points left. That covers the
part which decides *what* to spend and *in what order* — the part that costs gold
when it is wrong. It cannot tell you the addon loads in a real client.

The round-trip test is the one that stops the two halves drifting apart: it
exports a build from the built `index.html` in headless Chrome and parses it with
the actual addon code in Lua.

## What is not here

- **No native import.** Classic has no talent loadout string like retail's, which
  is why this addon exists at all.
- **No respec.** It only adds points.
- **Forever is unreleased** at the time of writing. `LearnTalent` is documented as
  supported there, but the client does not exist yet to try it on.
