Expansion logos for the edition switcher, from Warcraft Wiki (warcraft.wiki.gg),
200px wide. build.js inlines them into index.html as data URIs, so the page keeps
working as a single file and the switcher never depends on a third-party host.

| File | Source file on warcraft.wiki.gg |
| --- | --- |
| forever.png | WoW_Forever_Logo.png |
| classic.png | WoW_Classic_logo.png |
| tbc.png     | WoW_BC_Classic_logo.png |
| wotlk.png   | WoW_Wrath_Classic_logo.png |
| cata.png    | WoW_Cataclysm_Classic_logo.png |

Refresh one with:

    curl -H "referer: https://warcraft.wiki.gg/" \
      "https://warcraft.wiki.gg/images/thumb/<File>.png/200px-<File>.png" \
      -o src/logos/<edition>.png

Trademarks belong to Blizzard Entertainment; they are used here the same way the
talent icons and tree art are, to label the trees they belong to.
