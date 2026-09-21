/**
 * Shared talent-dataset validation, used by build.js at build time and by the
 * server before it writes an edited dataset. Returns a list of human-readable
 * problems; an empty list means the dataset is safe to render.
 */
const MAX_RANK = 5;
const COLS = 4;

const row = pos => pos.charCodeAt(0) - 97;
const col = pos => Number(pos[1]) - 1;

function validateDataset(data) {
  const problems = [];
  const push = (where, msg) => problems.push(`${where}: ${msg}`);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["dataset must be an object keyed by class name"];
  }
  const classNames = Object.keys(data);
  if (!classNames.length) return ["dataset has no classes"];

  for (const klass of classNames) {
    const cls = data[klass];
    if (!cls || !Array.isArray(cls.trees) || !cls.trees.length) {
      push(klass, "needs a non-empty trees array");
      continue;
    }
    if (cls.trees.length !== 3) push(klass, `has ${cls.trees.length} trees, expected 3`);

    const treeIds = new Set();
    for (const tree of cls.trees) {
      const where = `${klass}/${tree && tree.name ? tree.name : "?"}`;
      if (!tree || typeof tree.id !== "string" || !tree.id) { push(where, "needs a string id"); continue; }
      if (treeIds.has(tree.id)) push(where, `duplicate tree id "${tree.id}"`);
      treeIds.add(tree.id);
      if (typeof tree.name !== "string" || !tree.name) push(where, "needs a name");
      if (typeof tree.icon !== "string" || !tree.icon) push(where, "needs an icon");
      if (!Array.isArray(tree.talents) || !tree.talents.length) { push(where, "has no talents"); continue; }

      const ids = new Set();
      const positions = new Map();

      for (const t of tree.talents) {
        const at = `${where}/${t && t.name ? t.name : "?"}`;
        if (!t || typeof t.id !== "string" || !t.id) { push(at, "needs a string id"); continue; }
        if (ids.has(t.id)) push(at, `duplicate talent id "${t.id}"`);
        ids.add(t.id);

        if (typeof t.name !== "string" || !t.name) push(at, "needs a name");
        if (typeof t.icon !== "string" || !t.icon) push(at, "needs an icon");
        if (typeof t.pos !== "string" || !/^[a-z][1-9]$/.test(t.pos)) {
          push(at, `bad pos "${t.pos}" (expected a letter then 1-${COLS})`);
          continue;
        }
        if (col(t.pos) >= COLS) push(at, `column ${col(t.pos) + 1} is outside the ${COLS}-wide grid`);
        if (positions.has(t.pos)) push(at, `shares cell ${t.pos} with ${positions.get(t.pos)}`);
        positions.set(t.pos, t.name);

        if (!Number.isInteger(t.maxRank) || t.maxRank < 1 || t.maxRank > MAX_RANK) {
          push(at, `maxRank must be 1-${MAX_RANK}, got ${t.maxRank}`);
        }
        if (!Array.isArray(t.ranks) || t.ranks.length !== t.maxRank) {
          push(at, `has ${Array.isArray(t.ranks) ? t.ranks.length : 0} rank descriptions for maxRank ${t.maxRank}`);
        } else if (t.ranks.some(r => typeof r !== "string" || !r.trim())) {
          push(at, "every rank needs description text");
        }
        if (!Number.isInteger(t.reqPoints) || t.reqPoints < 0) {
          push(at, `reqPoints must be a non-negative integer, got ${t.reqPoints}`);
        }
      }

      // cross-talent checks, once every talent in the tree is known
      for (const t of tree.talents) {
        if (!t || typeof t.pos !== "string" || !/^[a-z][1-9]$/.test(t.pos)) continue;
        const at = `${where}/${t.name}`;

        if (t.prereq) {
          const pre = tree.talents.find(x => x.id === t.prereq);
          if (!pre) push(at, `prereq "${t.prereq}" is not in this tree`);
          else if (pre.id === t.id) push(at, "cannot require itself");
          else if (row(pre.pos) > row(t.pos)) push(at, `prereq "${t.prereq}" sits below it`);
        }

        const above = tree.talents
          .filter(x => x !== t && typeof x.pos === "string" && row(x.pos) < row(t.pos))
          .reduce((n, x) => n + (Number.isInteger(x.maxRank) ? x.maxRank : 0), 0);
        if (Number.isInteger(t.reqPoints) && above < t.reqPoints) {
          push(at, `needs ${t.reqPoints} points but only ${above} exist in the rows above it`);
        }
      }

      // a prereq chain must not loop
      for (const t of tree.talents) {
        const seen = new Set();
        let cur = t;
        while (cur && cur.prereq) {
          if (seen.has(cur.id)) { push(`${where}/${t.name}`, "prereq chain loops"); break; }
          seen.add(cur.id);
          cur = tree.talents.find(x => x.id === cur.prereq);
        }
      }
    }
  }
  return problems;
}

module.exports = { validateDataset, MAX_RANK, COLS };
