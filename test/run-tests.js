#!/usr/bin/env node
/**
 * Drives the built index.html in headless Chrome and asserts the talent rules.
 *
 *   node test/run-tests.js
 *
 * Set CHROME=/path/to/chrome if it is not in one of the usual places.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const page = path.join(root, "index.html");

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!chrome) {
  console.error("No Chrome found. Set CHROME=/path/to/chrome and retry.");
  process.exit(1);
}
if (!fs.existsSync(page)) {
  console.error("index.html is missing — run `node build.js` first.");
  process.exit(1);
}

// The suite runs inside the page, against the page's own functions.
const suite = `
(function(){
  const out = [];
  let pass = 0, fail = 0;
  try {
  const ok = (name, cond) => { cond ? pass++ : fail++; out.push((cond ? 'PASS  ' : 'FAIL  ') + name); };
  const T = n => trees().find(t => t.name === n);
  const tal = (tr, n) => tr.talents.find(t => t.name === n);
  const rank = (tr, n) => state[tr.id][n];

  // spending and tier gates
  selectClass('Warrior'); level = 60;
  let arms = T('Arms');
  const ihs = tal(arms, 'Improved Heroic Strike'), defl = tal(arms, 'Deflection');
  const chg = tal(arms, 'Improved Charge');

  learn(arms, ihs); learn(arms, ihs);
  ok('click adds ranks', rank(arms, 'Improved Heroic Strike') === 2);
  learn(arms, ihs); learn(arms, ihs);
  ok('cannot exceed maxRank', rank(arms, 'Improved Heroic Strike') === 3);
  learn(arms, chg);
  ok('tier 2 blocked under 5 pts', rank(arms, 'Improved Charge') === 0);
  learn(arms, defl); learn(arms, defl);
  ok('5 pts in tree', treePoints(arms) === 5);
  learn(arms, chg);
  ok('tier 2 opens at 5 pts', rank(arms, 'Improved Charge') === 1);

  // unlearning must never strand a higher tier
  unlearn(arms, ihs);
  ok('unlearn blocked when it breaks a tier gate', rank(arms, 'Improved Heroic Strike') === 3);
  unlearn(arms, chg);
  ok('unlearn higher tier first', rank(arms, 'Improved Charge') === 0);
  unlearn(arms, ihs);
  ok('then lower tier frees up', rank(arms, 'Improved Heroic Strike') === 2);

  // prereq chains
  resetAll(); arms = T('Arms');
  const tm = tal(arms, 'Tactical Mastery'), anger = tal(arms, 'Anger Management');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tm, true);
  ok('shift-click maxes a talent', rank(arms, 'Tactical Mastery') === 5);
  learn(arms, anger);
  ok('prereq met unlocks talent', rank(arms, 'Anger Management') === 1);
  unlearn(arms, tm);
  ok('cannot break a prereq by unlearning', rank(arms, 'Tactical Mastery') === 5);
  unlearn(arms, anger); unlearn(arms, tm);
  ok('prereq frees once dependent removed', rank(arms, 'Tactical Mastery') === 4);

  // level drives the point budget
  resetAll(); level = 10; arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'));
  learn(arms, tal(arms, 'Improved Heroic Strike'));
  ok('level 10 grants exactly 1 point', totalPoints() === 1);
  level = 60;
  ok('level 60 grants 51 points', availablePoints() === 51);

  // share codes
  resetAll(); arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tal(arms, 'Tactical Mastery'), true);
  const before = JSON.stringify(state), code = encode(), pts = totalPoints();
  resetAll();
  ok('reset clears everything', totalPoints() === 0);
  decode(code);
  ok('decode restores the build', JSON.stringify(state) === before && totalPoints() === pts);
  ok('code names the class', code.indexOf('warrior') === 0);
  ok('garbage hash is rejected', decode('notaclass-12345') === false);
  decode('mage-5555555555555555555555555555555555555555555555555555');
  ok('over-budget hash falls back to empty', totalPoints() === 0 && klass === 'Mage');

  // every class renders every talent
  let renderOk = true;
  for (const k of classList()) {
    selectClass(k);
    const expect = trees().reduce((n, t) => n + t.talents.length, 0);
    if (document.querySelectorAll('#trees .talent').length !== expect) renderOk = false;
  }
  ok('all 9 classes render every talent', renderOk);

  // the 51-point cap
  selectClass('Warrior'); level = 60;
  let fury = T('Fury');
  for (const t of fury.talents) learn(fury, t, true);
  ok('cannot spend past 51', totalPoints() === 51);

  // a real 31-point build reaches the capstone
  resetAll(); fury = T('Fury');
  ['Booming Voice','Unbridled Wrath','Improved Battle Shout','Enrage'].forEach(
    n => learn(fury, tal(fury, n), true));
  learn(fury, tal(fury, 'Death Wish'), true);
  for (let i = 0; i < 4; i++) learn(fury, tal(fury, 'Improved Slam'));
  learn(fury, tal(fury, 'Flurry'), true);
  ok('30 points opens the last tier', treePoints(fury) === 30);
  const bt = tal(fury, 'Bloodthirst');
  learn(fury, bt);
  ok('capstone reachable at 31 points', state[fury.id][bt.id] === 1 && totalPoints() === 31);

  // ... and the capstone's prereq is really enforced
  resetAll(); fury = T('Fury');
  ['Booming Voice','Unbridled Wrath','Improved Battle Shout','Enrage','Improved Slam','Flurry']
    .forEach(n => learn(fury, tal(fury, n), true));
  ok('30 points without Death Wish', treePoints(fury) === 30);
  learn(fury, tal(fury, 'Bloodthirst'));
  ok('capstone blocked without its prereq', state[fury.id]['Bloodthirst'] === 0);

  /* ---- per-class drafts ---- */
  selectEdition(EDITIONS[0]);
  selectClass('Warrior'); level = 60; resetAll();
  let wArms = T('Arms');
  learn(wArms, tal(wArms, 'Improved Heroic Strike'), true);   // 3 points
  const warriorPts = totalPoints();

  selectClass('Mage');
  ok('a fresh class starts empty', totalPoints() === 0);
  const mFire = T('Fire');
  learn(mFire, mFire.talents.filter(t => t.reqPoints === 0)[0], true);
  const magePts = totalPoints();
  ok('the new class can be built on', magePts > 0);

  selectClass('Warrior');
  ok('going back keeps the first build', totalPoints() === warriorPts);
  selectClass('Mage');
  ok('and the second one too', totalPoints() === magePts);

  // drafts are per edition as well as per class
  selectEdition(editionById('forever'));
  ok('the same class in another edition starts empty', totalPoints() === 0);
  selectEdition(EDITIONS[0]);
  ok('and coming back still has the Classic+ build', totalPoints() === magePts);

  selectClass('Warrior'); resetAll();
  ok('reset clears only the class it is on', totalPoints() === 0);
  selectClass('Mage');
  ok('the other class is untouched by that reset', totalPoints() === magePts);
  resetAll(); selectClass('Warrior'); resetAll();

  /* ---- level needed ---- */
  const doneAt = document.getElementById('doneAt');
  ok('no finish level with nothing spent', doneAt.style.display === 'none');

  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);     // 3 points
  ok('the finish level shows once points are in', doneAt.style.display !== 'none');
  ok('3 points finishes at level 12',
    doneAt.querySelector('b').textContent === '12', doneAt.querySelector('b').textContent);
  ok('it agrees with the levelling path',
    doneAt.querySelector('b').textContent === String(levelPath()[levelPath().length - 1].level));

  learn(arms, tal(arms, 'Deflection'), true);                 // 5 more, 8 total
  ok('it tracks as points go in', doneAt.querySelector('b').textContent === '17');
  ok('and is not flagged as over the cap', !doneAt.classList.contains('over'));
  resetAll();

  /* ---- spellbook ---- */
  selectEdition(EDITIONS[0]); selectClass('Warrior'); resetAll();
  ok('training costs read as money, not seconds',
    money(10) === '10c' && money(1000) === '10s' && money(12345) === '1g 23s 45c',
    money(10) + ' / ' + money(1000) + ' / ' + money(12345));
  ok('an edition with no spellbook is known to have none', hasBook('tbc') === false);
  ok('spellbook mode is off to start with', bookOn === false);

  setBook(true);
  ok('opening the spellbook hides the trees',
    bookOn === true && document.getElementById('trees').style.display === 'none');
  ok('and puts a book link in the address bar', encodeBook().indexOf('book:') === 0);
  ok('the link names the edition and class', encodeBook() === 'book:custom:warrior', encodeBook());
  setBook(false);
  ok('leaving the spellbook brings the trees back',
    bookOn === false && document.getElementById('trees').style.display !== 'none');
  ok('and empties it from the document',
    document.getElementById('book').innerHTML === '');

  ok('a book link for a class that exists is accepted',
    decodeBook('book:custom:druid') === true && klass === 'Druid' && bookOn === true);
  setBook(false);
  ok('a book link for an unknown edition is refused', decodeBook('book:nosuch:druid') === false);
  selectClass('Warrior'); resetAll();

  // search
  ok('a match is wrapped for highlighting', (() => {
    const el = document.createElement('div');
    markMatch(el, 'Battle Shout', 'shout');
    return el.querySelector('mark') && el.querySelector('mark').textContent === 'Shout' &&
           el.textContent === 'Battle Shout';
  })());
  ok('no needle leaves the text alone', (() => {
    const el = document.createElement('div');
    markMatch(el, 'Battle Shout', '');
    return !el.querySelector('mark') && el.textContent === 'Battle Shout';
  })());
  ok('markMatch never interprets markup', (() => {
    const el = document.createElement('div');
    markMatch(el, '<img src=x onerror=1> Shout', 'shout');
    return el.querySelector('img') === null && el.textContent.indexOf('<img') === 0;
  })());

  /* ---- compare board ---- */
  selectEdition(EDITIONS[0]); selectClass('Warrior'); level = 60; resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);   // 3 points

  setCompare(true);
  ok('compare mode turns on', boardOn === true);
  ok('it seeds from the build you were on', board.length === 3);
  ok('and brings its points with it', panelPoints(board[0]) === 3);
  ok('the normal trees are hidden', document.getElementById('trees').style.display === 'none');
  ok('so are the edition and class bars',
    document.getElementById('editions').style.display === 'none' &&
    document.getElementById('classes').style.display === 'none');
  ok('a panel is rendered per slot', document.querySelectorAll('.board .slot').length === 3);

  // each panel is its own build
  const p0 = board[0], p1 = board[1];
  const t0 = panelTree(p0);
  panelLearn(p0, t0, t0.talents.filter(x => x.reqPoints === 0)[1], true);
  ok('spending in one panel leaves the others alone',
    panelPoints(p0) > 3 && panelPoints(p1) === 0);

  // tier gates are evaluated per panel
  const deep = t0.talents.find(x => x.reqPoints >= 25);
  if (deep) {
    const before = p0.st[t0.id][deep.id];
    panelLearn(p0, t0, deep, false);
    ok('a panel enforces its own tier gates', p0.st[t0.id][deep.id] === before);
  } else {
    ok('a panel enforces its own tier gates', true);
  }

  // panels can come from anywhere
  const extra = newPanel('cata', 'Death Knight', 'Blood');
  ok('a panel can be built from any edition and class', Boolean(extra));
  board.push(extra); renderBoard();
  ok('the board takes a Cata Death Knight tree', board.length === 4 &&
    document.querySelectorAll('.board .slot').length === 4);

  // codes
  const bcode = encodeBoard();
  ok('the board encodes to a cmp code', bcode.indexOf('cmp:') === 0, bcode.slice(0, 60));
  ok('the code names each panel', bcode.split(',').length === 4);
  const snapshot = board.map(p => p.ed.id + '/' + p.klass + '/' + p.tree + '/' + panelPoints(p)).join();

  board = []; renderBoard();
  ok('the board can be emptied', board.length === 0);
  ok('and shows only the add button',
    document.querySelectorAll('.board .slot').length === 0 &&
    document.querySelectorAll('.board .add').length === 1);

  ok('a cmp code restores the board', decodeBoard(bcode) === true);
  ok('with every panel and its points intact',
    board.map(p => p.ed.id + '/' + p.klass + '/' + p.tree + '/' + panelPoints(p)).join() === snapshot);

  // removing and reordering
  const firstEd = board[0].ed.id, secondEd = board[1].ed.id;
  const moved = board.splice(0, 1)[0]; board.splice(1, 0, moved); renderBoard();
  ok('panels can be reordered', board[0].ed.id === secondEd && board[1].ed.id === firstEd);
  board.splice(0, 1); renderBoard();
  ok('a panel can be removed', board.length === 3);

  // the board lays out as a grid, so panels flow onto the next row instead of
  // being squeezed shoulder to shoulder in one long line
  board = [];
  for (const id of ['forever', 'classic', 'tbc', 'wotlk', 'cata']) {
    const p = newPanel(id, 'Warrior', 'Arms');
    if (p) board.push(p);
  }
  renderBoard();
  const boardEl = document.getElementById('board');
  const cols = getComputedStyle(boardEl).gridTemplateColumns.split(' ').filter(Boolean).length;
  ok('the board is a grid', getComputedStyle(boardEl).display === 'grid');
  ok('it is at most three columns wide', cols > 0 && cols <= 3, cols);
  ok('every panel is on it, however many rows that takes',
    document.querySelectorAll('.board .slot').length === board.length);
  ok('and the add button comes after them',
    document.querySelectorAll('.board .add').length === 1);

  ok('rubbish cmp codes are refused', decodeBoard('cmp:nosuch.warrior.arms') === false);

  setCompare(false);
  ok('leaving compare restores the trees',
    boardOn === false && document.getElementById('trees').style.display !== 'none');
  ok('and the build is still there', totalPoints() === 3);
  resetAll();

  /* ---- favicon ---- */
  const icon = document.querySelector('link[rel="icon"]');
  ok('the page declares a tab icon', Boolean(icon));
  ok('the icon is inlined, so it needs no request',
    icon && icon.getAttribute('href').indexOf('data:image/svg+xml,') === 0);
  ok('the icon svg actually parses', Boolean(icon) && (() => {
    const svg = decodeURIComponent(icon.getAttribute('href').slice('data:image/svg+xml,'.length));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return !doc.querySelector('parsererror') && doc.documentElement.tagName === 'svg';
  })());

  /* ---- spec bar ---- */
  selectEdition(EDITIONS[0]);
  selectClass('Warrior'); level = 60; resetAll();
  ok('a spec card per tree', document.querySelectorAll('#summary .spec').length === 3);
  ok('the bottom of a Classic tree is 31 points', treeDepth(T('Arms')) === 31);
  ok('empty trees have empty bars',
    [...document.querySelectorAll('#summary .sp-bar i')].every(i => i.style.width === '0%'));

  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);   // 3 points
  const cards = document.querySelectorAll('#summary .spec');
  ok('points show against the right tree',
    cards[0].querySelector('.sp-pts').textContent === '3' &&
    cards[1].querySelector('.sp-pts').textContent === '0');
  ok('the bar fills toward the bottom of the tree',
    cards[0].querySelector('.sp-bar i').style.width === Math.round(3 / 31 * 100) + '%');
  ok('only a tree with points is marked', cards[0].classList.contains('on') &&
    !cards[1].classList.contains('on'));
  ok('the deepest tree is flagged as the spec', cards[0].classList.contains('lead'));
  resetAll();

  /* ---- levelling path ---- */
  selectEdition(EDITIONS[0]);
  selectClass('Warrior'); level = 60; resetAll();
  ok('no points means no levelling path', levelPath().length === 0);

  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tal(arms, 'Tactical Mastery'), true);
  learn(arms, tal(arms, 'Anger Management'));

  let path = levelPath();
  ok('one step per point spent', path.length === totalPoints());
  ok('the first point lands at level 10', path[0] && path[0].level === 10);
  ok('levels run consecutively',
    path.every((s, i) => s.level === 10 + i));
  ok('ranks count up per talent',
    path.filter(s => s.tal.name === 'Tactical Mastery').every((s, i) => s.rank === i + 1));

  // replay the path and check every step was legal when it was taken
  const sim = {};
  for (const tr of trees()) { sim[tr.id] = {}; for (const t of tr.talents) sim[tr.id][t.id] = 0; }
  let legal = true;
  for (const s of path) {
    if (!tierMet(s.tree, s.tal, sim) || !prereqMet(s.tree, s.tal, sim)) legal = false;
    sim[s.tree.id][s.tal.id]++;
    if (sim[s.tree.id][s.tal.id] > s.tal.maxRank) legal = false;
  }
  ok('every step in the path is legal when taken', legal);
  ok('the path rebuilds the exact build',
    JSON.stringify(sim) === JSON.stringify(state));
  ok('a prereq is fully ranked before its dependent appears',
    path.findIndex(s => s.tal.name === 'Anger Management') >
    path.findLastIndex(s => s.tal.name === 'Tactical Mastery'));

  // a build across two trees has to interleave by tier, not finish one tree first
  const fury2 = T('Fury');
  learn(fury2, tal(fury2, 'Booming Voice'), true);
  path = levelPath();
  ok('a two-tree build still has one step per point', path.length === totalPoints());
  ok('both trees appear in the path',
    new Set(path.map(s => s.tree.name)).size === 2);
  // within one tree the path only ever moves down the tree, never back up a tier
  const lastRow = {};
  let downwards = true;
  for (const s of path) {
    const r = s.tal.pos.charCodeAt(0);
    if (lastRow[s.tree.id] !== undefined && r < lastRow[s.tree.id]) downwards = false;
    lastRow[s.tree.id] = r;
  }
  ok('each tree is filled top down', downwards);

  // the path must follow what you clicked, not a tidy-looking reshuffle
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Rend'), true);            // row a, col 3
  const afterFirst = levelPath().map(s => s.tal.name).join();
  ok('the first talent taken starts the path',
    afterFirst.indexOf('Improved Rend') === 0, afterFirst);

  learn(arms, tal(arms, 'Improved Heroic Strike'), true);   // row a, col 1
  path = levelPath();
  ok('a later click is appended, not inserted above',
    path[0].tal.name === 'Improved Rend' &&
    path[path.length - 1].tal.name === 'Improved Heroic Strike',
    path.map(s => s.tal.name).join());
  ok('and the earlier levels do not shift',
    path[0].level === 10 && path[1].level === 11 && path[2].level === 12);

  // unlearning takes the right one back out
  unlearn(arms, tal(arms, 'Improved Heroic Strike'));
  path = levelPath();
  ok('unlearning drops the last rank of that talent',
    path.length === totalPoints() &&
    path.filter(s => s.tal.name === 'Improved Heroic Strike').length === 2);
  ok('and the rest keep their place', path[0].tal.name === 'Improved Rend');

  // clearing a tree forgets only that tree
  resetAll();
  let fury3 = T('Fury');
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Rend'), true);
  learn(fury3, tal(fury3, 'Booming Voice'), true);
  clearTree(fury3);
  path = levelPath();
  ok('clearing a tree forgets only its own points',
    path.length === totalPoints() && path.every(s => s.tree.name === 'Arms'),
    path.map(s => s.tree.name).join());

  // a build with no history still gets a legal derived path
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tal(arms, 'Tactical Mastery'), true);
  const histCode = encode();
  resetAll();
  decode(histCode);
  ok('a link with no history still produces a path',
    levelPath().length === totalPoints());
  ok('and that path is still legal', (() => {
    const sim = {};
    for (const tr of trees()) { sim[tr.id] = {}; for (const t of tr.talents) sim[tr.id][t.id] = 0; }
    for (const s of levelPath()) {
      if (!tierMet(s.tree, s.tal, sim) || !prereqMet(s.tree, s.tal, sim)) return false;
      sim[s.tree.id][s.tal.id]++;
    }
    return true;
  })());
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tal(arms, 'Tactical Mastery'), true);
  learn(arms, tal(arms, 'Anger Management'));
  path = levelPath();

  // a build that arrived from a link gets a seeded history, so a talent clicked
  // afterwards is appended rather than dragging the whole path back to grid order
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);   // 3 points, row a
  const seedCode = encode();
  resetAll();
  decode(seedCode);
  ok('a link gets a history to build on', levelPath().length === totalPoints());

  learn(arms, tal(arms, 'Deflection'), true);               // clicked after loading
  path = levelPath();
  ok('a click after a link is appended, not sorted in',
    path[path.length - 1].tal.name === 'Deflection' &&
    path[0].tal.name === 'Improved Heroic Strike',
    path.map(s => s.tal.name).join());
  ok('and the loaded points keep their levels',
    path[0].level === 10 && path[2].level === 12);

  // a deep talent clicked as soon as it unlocks stays where it was taken
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  const deepCode = encode();
  resetAll();
  decode(deepCode);
  const tm2 = tal(T('Arms'), 'Tactical Mastery');
  learn(T('Arms'), tm2);
  const posAfter = levelPath().findIndex(s => s.tal.name === 'Tactical Mastery');
  learn(T('Arms'), tal(T('Arms'), 'Improved Rend'), true);
  ok('a deep talent does not slide to the end when more is spent after it',
    levelPath().findIndex(s => s.tal.name === 'Tactical Mastery') === posAfter,
    posAfter + ' -> ' + levelPath().findIndex(s => s.tal.name === 'Tactical Mastery'));
  resetAll();
  arms = T('Arms');
  learn(arms, tal(arms, 'Improved Heroic Strike'), true);
  learn(arms, tal(arms, 'Deflection'), true);
  learn(arms, tal(arms, 'Tactical Mastery'), true);
  learn(arms, tal(arms, 'Anger Management'));
  path = levelPath();

  // and it survives a share code, which carries no ordering at all
  const pathCode = encode();
  resetAll();
  decode(pathCode);
  ok('the path comes back after a round trip',
    levelPath().map(s => s.tal.name + s.rank).join() === path.map(s => s.tal.name + s.rank).join());
  resetAll();

  /* ---- editions ---- */
  selectEdition(EDITIONS[0]);
  ok('Classic+ is the default edition', edition.id === 'custom');
  ok('its codes carry no prefix', encode().indexOf(':') < 0);

  const forever = editionById('forever');
  if (!forever) {
    ok('forever edition is present', false);
  } else {
    selectEdition(forever);
    ok('switching edition swaps the dataset', edition.id === 'forever' && trees() !== undefined);
    ok('edition keeps the class', klass === 'Warrior');
    ok('every edition class renders', classList().every(k => {
      selectClass(k);
      return document.querySelectorAll('#trees .talent').length ===
        trees().reduce((n, t) => n + t.talents.length, 0);
    }));

    // Forever-only talents really are there, and the Classic+ trees do not have them
    selectClass('Druid');
    const bal = T('Balance');
    ok('Forever has Eclipse in Balance', !!tal(bal, 'Eclipse'));

    // a Forever code round-trips, prefix and all
    selectClass('Warrior'); resetAll(); level = 60;
    const fArms = T('Arms');
    learn(fArms, fArms.talents.find(t => t.reqPoints === 0), true);
    const fCode = fArms.talents.length ? encode() : '';
    ok('Forever codes name their edition', fCode.indexOf('forever:') === 0);
    const fState = JSON.stringify(state), fPts = totalPoints();

    selectEdition(EDITIONS[0]);
    ok('leaving the edition clears the build', totalPoints() === 0 && edition.id === 'custom');
    decode(fCode);
    ok('a Forever code switches back to Forever', edition.id === 'forever');
    ok('and restores the build', JSON.stringify(state) === fState && totalPoints() === fPts);

    // the fingerprint still guards against a changed layout
    ok('a Forever code carries a fingerprint', /\\.[0-9a-z]+$/.test(fCode));

    // edit mode is for the Classic+ trees only
    setEditing(true);
    ok('edit mode refused on a read-only edition', editing === false);

    selectEdition(EDITIONS[0]);
  }

  // every shipped edition renders every class, with its own budget and level cap
  const expected = { forever: [51, 60], classic: [51, 60], tbc: [61, 70], wotlk: [71, 80], cata: [41, 85] };
  for (const ed of EDITIONS) {
    if (ed.id === 'custom') continue;
    selectEdition(ed);
    const want = expected[ed.id];
    if (want) {
      ok(ed.id + ': level follows the cap (' + want[1] + ')', level === want[1]);
      ok(ed.id + ': budget is ' + want[0] + ' points', availablePoints() === want[0]);
    }
    // data checks for every class (rendering them all would mean thousands of
    // icon requests, which is what the one render below is for)
    let dataOk = classList().length > 0;
    for (const k of classList()) {
      for (const tr of ed.classes[k].trees) {
        if (!tr.talents.length) dataOk = false;
        const cells = new Set();
        for (const t of tr.talents) {
          if (cells.has(t.pos)) dataOk = false;
          cells.add(t.pos);
          if (t.ranks.length !== t.maxRank) dataOk = false;
          if (t.prereq && !tr.talents.some(x => x.id === t.prereq)) dataOk = false;
        }
      }
      if (ed.classes[k].trees.length !== 3) dataOk = false;
    }
    ok(ed.id + ': every class is well formed', dataOk);

    selectClass(classList()[0]);
    ok(ed.id + ': renders every talent',
      document.querySelectorAll('#trees .talent').length ===
      trees().reduce((n, t) => n + t.talents.length, 0));

    // a code from this edition survives a round trip, prefix and all
    resetAll();
    const first = trees()[0];
    const base = first.talents.filter(t => t.reqPoints === 0)[0];
    learn(first, base, true);
    const c = encode(), snap = JSON.stringify(state);
    resetAll();
    decode(c);
    ok(ed.id + ': codes round-trip',
      c.indexOf(ed.id + ':') === 0 && JSON.stringify(state) === snap);
    resetAll();
  }
  // "Death Knight" has a space, so its codes have to survive the round trip too
  selectEdition(editionById('wotlk'));
  selectClass('Death Knight');
  ok('Death Knight selects in Wrath', klass === 'Death Knight' && trees().length === 3);
  // every class icon has to be a real wowhead name - a space would 404.
  // plain string checks rather than a regex: this suite lives in a template
  // literal, where a backslash escape is eaten before the page ever sees it.
  const clsSrc = () => [...document.querySelectorAll('.cls img')].map(i => i.getAttribute('src'));
  ok('class icons have no spaces in their names',
    clsSrc().every(s => s.indexOf(' ') < 0 && s.indexOf('%20') < 0));
  ok('the Death Knight icon is class_deathknight',
    clsSrc().some(s => s.endsWith('/class_deathknight.jpg')));
  resetAll();
  const dkTree = trees()[0];
  learn(dkTree, dkTree.talents.filter(t => t.reqPoints === 0)[0], true);
  const dkCode = encode(), dkState = JSON.stringify(state);
  ok('Death Knight codes have no space', dkCode.indexOf('wotlk:deathknight-') === 0, dkCode);
  selectEdition(EDITIONS[0]);
  decode(dkCode);
  ok('a Death Knight code round-trips',
    edition.id === 'wotlk' && klass === 'Death Knight' && JSON.stringify(state) === dkState);
  selectEdition(EDITIONS[0]);

  ok('Death Knight exists in Wrath and Cata only',
    EDITIONS.filter(e => e.classes['Death Knight']).map(e => e.id).sort().join(',') === 'cata,wotlk');
  selectEdition(EDITIONS[0]);
  ok('unknown editions are rejected, not guessed', decode('nosuchedition:warrior-5') === false);

  /* ---------------- the levelling path survives a reload ---------------- */
  /*
   * A share code carries ranks and no history, and the address bar IS the
   * build - so reloading the page meant re-reading your own link and losing
   * the order you clicked in. The path then rearranged itself for no reason a
   * reader could see. The order is the one thing a code cannot carry, so the
   * draft keeps it and seedOrder prefers it over a guess.
   */
  selectEdition(editionById('forever'));
  selectClass('Shaman');
  level = 60;
  resetAll();
  var pEle = trees().find(function (t) { return t.name === 'Elemental'; });
  var pEnh = trees().find(function (t) { return t.name === 'Enhancement'; });
  var pick = function (tr, n) { return tr.talents.find(function (x) { return x.name === n; }); };

  learn(pEle, pick(pEle, 'Concussion'));
  learn(pEnh, pick(pEnh, 'Thundering Strikes'));
  learn(pEle, pick(pEle, 'Convection'));
  var clickedPath = levelPath().map(function (s) { return s.tal.name; }).join(',');
  ok('the path follows the clicks',
    clickedPath === 'Concussion,Thundering Strikes,Convection');

  var savedCode = encode();
  ok('the order is remembered for this build', orderMatches(drafts[stateKey].order));

  // exactly what opening the link does
  seedOrder();
  ok('reopening the build keeps the clicked order',
    levelPath().map(function (s) { return s.tal.name; }).join(',') === clickedPath);

  // a record that does not account for the build must be refused, or the path
  // would claim points that are not there
  ok('a stale order is rejected', orderMatches(['Elemental::Concussion']) === false);
  ok('an order of the right length but wrong talents is rejected',
    orderMatches(['Elemental::Concussion', 'Elemental::Concussion',
                  'Elemental::Concussion']) === false);
  ok('a non-array is rejected', orderMatches(null) === false);

  // with no usable record it still produces a legal path rather than nothing
  var keep = drafts[stateKey];
  delete drafts[stateKey];
  seedOrder();
  ok('without a record the path is derived, not empty',
    levelPath().length === totalPoints());
  drafts[stateKey] = keep;

  ok('drafts are written where a reload can find them', (function () {
    try {
      var raw = localStorage.getItem('cplus-drafts');
      return typeof raw === 'string' && raw.length > 2;
    } catch (e) { return true; }   // storage blocked: nothing to assert
  })());

  resetAll();

  /* ---------------- the order travels in the code ---------------- */
  /*
   * Remembering the order in this browser only ever helped a reload. A saved
   * build opened later, or a link sent to somebody else, still came back sorted
   * by grid position - which is what a 48-point build did, and it was reported.
   */
  selectEdition(editionById('forever'));
  selectClass('Shaman');
  level = 60;
  resetAll();
  var oEnh = trees().find(function (t) { return t.name === 'Enhancement'; });
  var oEle = trees().find(function (t) { return t.name === 'Elemental'; });
  var oPick = function (tr, n) { return tr.talents.find(function (x) { return x.name === n; }); };

  // deliberately not grid order: the second tree first, then back
  learn(oEle, oPick(oEle, 'Concussion'));
  learn(oEnh, oPick(oEnh, 'Thundering Strikes'), true);
  learn(oEle, oPick(oEle, 'Convection'));
  var builtOrder = levelPath().map(function (s) { return s.tal.name + s.rank; }).join(',');
  var orderedCode = encode();

  ok('the code carries an order', orderedCode.indexOf('!') > 0);
  ok('the order sits before the fingerprint',
    orderedCode.indexOf('!') < orderedCode.lastIndexOf('.'));

  // import it with no memory of having built it, which is what opening a saved
  // build or somebody else's link actually does
  resetAll();
  var savedDrafts = {};
  Object.keys(drafts).forEach(function (k) { savedDrafts[k] = drafts[k]; delete drafts[k]; });
  decode(orderedCode);
  ok('importing keeps the order it was built in',
    levelPath().map(function (s) { return s.tal.name + s.rank; }).join(',') === builtOrder);
  ok('importing keeps the points too', totalPoints() === 7);
  Object.keys(savedDrafts).forEach(function (k) { drafts[k] = savedDrafts[k]; });

  // codes made before this existed have no "!" and must still work
  var oldCode = orderedCode.replace(/![^.]*/, '');
  resetAll();
  ok('a code with no order still loads', decode(oldCode) !== false && totalPoints() === 7);
  ok('and gets a derived path rather than none', levelPath().length === 7);

  // a hand-edited order must not be allowed to claim points that are not there
  resetAll();
  var tampered = orderedCode.replace(/!([^.]*)/, '!' + '000');
  decode(tampered);
  ok('an order that does not fit the build is ignored', levelPath().length === totalPoints());

  ok('an empty build produces no order segment', (function () {
    resetAll();
    return encode().indexOf('!') === -1;
  })());

  // the index has to reach the biggest class there is
  ok('a class with more than 62 talents round-trips', (function () {
    selectEdition(editionById('wotlk'));
    selectClass('Death Knight');
    level = 60;
    resetAll();
    var tr = trees()[0];
    var first = tr.talents.filter(function (t) { return t.reqPoints === 0; })[0];
    learn(tr, first, true);
    var second = trees()[1].talents.filter(function (t) { return t.reqPoints === 0; })[0];
    learn(trees()[1], second);
    var want = levelPath().map(function (s) { return s.tal.name + s.rank; }).join(',');
    var c = encode();
    resetAll();
    Object.keys(drafts).forEach(function (k) { delete drafts[k]; });
    decode(c);
    return levelPath().map(function (s) { return s.tal.name + s.rank; }).join(',') === want;
  })());

  selectEdition(editionById('forever'));
  selectClass('Shaman');
  resetAll();

  /* ---------------- the json export ---------------- */
  /*
   * It exists so something else can decide where the next point should go.
   * That needs the whole class, every rank, and the gate on each talent - a
   * list of what is already taken answers nothing.
   */
  selectEdition(editionById('forever'));
  selectClass('Shaman');
  level = 60;
  resetAll();
  var enh = trees().find(function (t) { return t.name === 'Enhancement'; });
  var thund = enh.talents.find(function (t) { return t.name === 'Thundering Strikes'; });
  learn(enh, thund); learn(enh, thund); learn(enh, thund);

  var j = buildAsJson();
  ok('the export knows the edition and class', j.edition.id === 'forever' && j.class === 'Shaman');
  ok('the export counts the points', j.points.spent === 3 && j.points.remaining === 48);
  ok('the export carries a share code', /^forever:shaman-/.test(j.shareCode));
  ok('the export says how the edition is shaped',
    j.edition.maxPoints === 51 && j.edition.firstPointAtLevel === FIRST_POINT_LEVEL);

  /* --- one flat list, not a tree of trees --- */
  ok('talents are a flat array', Array.isArray(j.talents));
  ok('the export lists every talent in the class', (function () {
    var inPage = trees().reduce(function (n, t) { return n + t.talents.length; }, 0);
    return j.talents.length === inPage && j.talents.length > 40;
  })());
  ok('every row names its own tree, so nothing has to be traversed',
    j.talents.every(function (t) { return typeof t.tree === 'string' && t.tree.length > 0; }));
  ok('trees are only a summary now',
    j.trees.length === 3 && j.trees.every(function (t) { return t.talents === undefined; }));
  ok('talents with no points are included too',
    j.talents.some(function (t) { return t.rank === 0; }));

  /* --- every rank, so points can be weighed against each other --- */
  ok('every talent carries every rank', j.talents.every(function (t) {
    if (t.ranks.length !== t.maxRank) return false;
    for (var i = 0; i < t.ranks.length; i++) {
      if (t.ranks[i].rank !== i + 1) return false;
      if (typeof t.ranks[i].description !== 'string') return false;
    }
    return true;
  }));

  var ex = j.talents.find(function (t) { return t.name === 'Thundering Strikes'; });
  ok('a talent reports its rank', ex.rank === 3 && ex.maxRank === 5);
  ok('current and next agree with the rank list',
    ex.current === ex.ranks[2].description && ex.next === ex.ranks[3].description);
  ok('a maxed talent has no next rank', (function () {
    learn(enh, thund); learn(enh, thund);
    var t = buildAsJson().talents.find(function (x) { return x.name === 'Thundering Strikes'; });
    return t.maxed === true && t.next === null;
  })());

  /* --- the gates, which are the easiest thing to get wrong --- */
  var gated = j.talents.find(function (t) { return t.requiresPointsInTree > 0 && t.rank === 0; });
  ok('a gated talent says what gates it', gated && gated.requiresPointsInTree > 0);
  ok('and that it cannot be taken yet', gated && gated.canLearnNow === false);
  ok('an open talent says it can be taken',
    j.talents.some(function (t) { return t.canLearnNow === true; }));
  ok('a prerequisite is named where there is one',
    j.talents.some(function (t) { return typeof t.requiresTalent === 'string'; }));

  // The requirement is measured against points in tiers ABOVE, not the tree
  // total - so both numbers are given, and they really can differ.
  ok('the export gives the number the gate is actually measured against',
    j.talents.every(function (t) {
      return typeof t.pointsAbove === 'number' && typeof t.pointsInTree === 'number';
    }));
  ok('pointsAbove is never more than the tree total',
    j.talents.every(function (t) { return t.pointsAbove <= t.pointsInTree; }));
  ok('canLearnNow agrees with the gate it reports',
    j.talents.every(function (t) {
      if (!t.canLearnNow) return true;
      return t.pointsAbove >= t.requiresPointsInTree && !t.maxed;
    }));

  ok('the export includes the levelling path', (function () {
    var p = buildAsJson().levellingPath;
    return p.length === totalPoints() && p[0].level === FIRST_POINT_LEVEL;
  })());
  ok('the export explains its own quirks', Array.isArray(j.notes) && j.notes.length > 0);
  // An empty build is the most useful thing to export, not the least: it is
  // what you send when the question is "what should I take".
  ok('an empty build still exports', (function () {
    resetAll();
    var e = buildAsJson();
    return e.points.spent === 0
        && e.talents.length > 40
        && e.talents.every(function (t) { return t.rank === 0; })
        && e.spec === 'nothing spent';
  })());

  ok('an empty build still knows what can be taken first', (function () {
    var e = buildAsJson();
    var open = e.talents.filter(function (t) { return t.canLearnNow; });
    // only the first tier of each tree is reachable with nothing spent
    return open.length > 0 && open.every(function (t) { return t.tier === 1; });
  })());

  ok('an empty build has an empty levelling path',
    buildAsJson().levellingPath.length === 0);

  ok('the export survives a round trip through JSON', (function () {
    try { return JSON.parse(JSON.stringify(buildAsJson())).class === 'Shaman'; }
    catch (e) { return false; }
  })());

  resetAll();
  selectEdition(EDITIONS[0]);

  report(out.join(' @@ ') + ' @@ ' + pass + ' passed, ' + fail + ' failed');
  } catch (err) {
    report('ERROR: ' + (err && err.message) + ' @@ ' + String(err.stack).slice(0, 240));
  }

  // Results go in a node of their own, not document.title: update() rewrites the
  // hash, the queued hashchange lands after this runs, and decoding it calls
  // selectEdition - which sets the title and would wipe the results.
  function report(text) {
    const el = document.createElement('div');
    el.id = '__results';
    el.textContent = text;
    document.body.appendChild(el);
  }
})();
`;

const html = fs.readFileSync(page, "utf8");
const at = html.lastIndexOf("</script>");
const tmp = path.join(os.tmpdir(), "cplus-talents-test.html");
fs.writeFileSync(tmp, html.slice(0, at) + suite + html.slice(at));

const dom = execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--virtual-time-budget=9000",
  "--dump-dom", "file:///" + tmp.replace(/\\/g, "/"),
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const found = dom.match(/<div id="__results">([\s\S]*?)<\/div>/);
const body = found && found[1]
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&");
if (!body) {
  console.error("The suite did not run — the page reported no result.");
  process.exit(1);
}

const lines = body.split(" @@ ");
for (const line of lines) console.log(line);
fs.unlinkSync(tmp);
process.exit(/(^|\s)[1-9]\d* failed/.test(lines[lines.length - 1]) ? 1 : 0);
