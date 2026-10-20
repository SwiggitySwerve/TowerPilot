const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {section} = require('./helpers.cjs');

/* The Screens tab re-renders on every 2.5 s status tick. A panel that embeds
   <img> elements must not be rewritten when its HTML is unchanged: each rewrite
   recreates every <img> and the browser asks for all of them again (a request
   storm, and a console 404 for each image the server does not have). */

const TARGETS = 115;

/* A status shaped like the live one: TARGETS installed-artwork targets and as
   many recognition-image report entries, every entry also cut from the screen. */
function status(verified = 0) {
  const rels = Array.from({length: TARGETS}, (_, i) => `group/target_${i}.png`);
  return {
    running: false,
    state: {phases: {bootstrap: {status: 'done', message: 'done', assets: {
      version: '1', images: 10, unique_images: 9, mapped: TARGETS, verified,
      targets: rels.map(rel => ({rel, names: ['sprite'], verification: 'pending'}))}}}},
    report: {entries: rels.map(rel => ({rel, status: 'written', verified: true, self: 1, next: 0.1}))},
  };
}

/* calibReport loaded from the real page against fake elements that record every
   innerHTML assignment. Returns the elements and a function running one tick. */
function page() {
  const regions = {};
  const region = id => regions[id] ||= {
    assignments: [],
    set innerHTML(html) { this.assignments.push(html); },
    get innerHTML() { return this.assignments.at(-1) ?? ''; },
  };
  const ids = ['#calib-report', '#asset-library-summary', '#calib-knowledge'];
  const ctx = vm.createContext({
    S: {calib: {have: Array.from({length: TARGETS}, (_, i) => `group/target_${i}.png`)}},
    $: selector => ids.includes(selector) ? region(selector) : selector === '#calib-phase2' ? {} : null,
    esc: v => String(v ?? ''), Date, JSON, Object, Array, Number,
    renderWorkspaceStatus: () => {}, calibrationBusy: () => {}, observationFeedback: () => {},
    renderCalibrationIntent: () => {}, renderScanTimeline: () => {}, renderScanPlan: () => {},
    api: async () => ({}),
  });
  vm.runInContext(section('function updateWorkspaceRegion(', 'function renderWorkspaceStatus('), ctx);
  vm.runInContext(section('function calibrationKnowledge(', 'function preparationStorageKey('), ctx);
  vm.runInContext(section('function artPair(', 'function outstandingCard('), ctx);
  vm.runInContext(section('function assetLibraryHTML(', 'function calibrationBusy('), ctx);
  ids.forEach(region);
  return {
    regions, ctx,
    tick(st) { ctx.st = st; vm.runInContext('calibReport(st)', ctx); },
  };
}

const writes = (p, id) => p.regions[id].assignments.length;
const artworkImgs = html => (html.match(/<img class="artwork" /g) || []).length;
const shotImgs = html => (html.match(/<img class="artwork shot" /g) || []).length;
const ids = ['#calib-report', '#asset-library-summary', '#calib-knowledge'];

/* Runs `ticks` identical ticks and returns how many times each panel was assigned.
   The tick count is bounded, so a page that rewrites every time fails the
   assertion at once instead of looping or waiting on a timer. */
function identicalTicks(p, ticks) {
  const st = status();
  for (let i = 0; i < ticks; i++) p.tick(st);
  return Object.fromEntries(ids.map(id => [id, writes(p, id)]));
}

test('identical status ticks assign each rendered panel once', {timeout: 5000}, () => {
  const p = page();
  assert.deepEqual(identicalTicks(p, 5), {'#calib-report': 1, '#asset-library-summary': 1, '#calib-knowledge': 1});
});

test('a changed status assigns the panel again', {timeout: 5000}, () => {
  const p = page();
  p.tick(status(0)); p.tick(status(0)); p.tick(status(7));
  assert.equal(writes(p, '#asset-library-summary'), 2);
  assert.match(p.regions['#asset-library-summary'].innerHTML, /7 verified on screen/);
  // report and knowledge panels did not change with the verified count
  assert.equal(writes(p, '#calib-report'), 1);
  assert.equal(writes(p, '#calib-knowledge'), 1);
  const changed = status(); changed.report.entries[3].status = 'stale';
  p.tick(changed);
  assert.equal(writes(p, '#calib-report'), 2);
});

test('an error or empty report is not skipped when the table returns', {timeout: 5000}, () => {
  const p = page();
  const st = status();
  const empty = status(); empty.report.entries = [];
  p.tick(st); p.tick(empty); p.tick(st);
  assert.equal(writes(p, '#calib-report'), 3);
  assert.match(p.regions['#calib-report'].innerHTML, /<table/);
});

test('a rewrite on every tick is caught by the same check', {timeout: 5000}, () => {
  const p = page();
  // the regression: the cache check is gone, so every call assigns
  vm.runInContext('updateWorkspaceRegion = (selector, html) => { const el = $(selector); if (el) el.innerHTML = html; };', p.ctx);
  const counts = identicalTicks(p, 5);
  assert.deepEqual(counts, {'#calib-report': 5, '#asset-library-summary': 5, '#calib-knowledge': 5});
  assert.notDeepEqual(counts, {'#calib-report': 1, '#asset-library-summary': 1, '#calib-knowledge': 1});
});

test('image elements created per status tick with one identical status', {timeout: 5000}, () => {
  const p = page();
  const ticks = 10;
  identicalTicks(p, ticks);
  let created = 0;
  for (const id of ids) for (const html of p.regions[id].assignments) created += artworkImgs(html) + shotImgs(html);
  const first = ['#calib-report', '#asset-library-summary'].map(id => p.regions[id].assignments[0]);
  console.log(`artwork imgs in the two panels: ${first.map(artworkImgs).join(' + ')}; screen-cut imgs: ${first.map(shotImgs).join(' + ')}; ` +
    `img elements created over ${ticks} identical ticks: ${created}`);
  // one artwork + one screen cut per target, in each of the two panels, created once
  assert.equal(created, 4 * TARGETS);
});
