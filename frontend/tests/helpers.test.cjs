const {test} = require('node:test');
const assert = require('node:assert/strict');
const {html, section} = require('./helpers.cjs');

test('section returns index.html from the start marker up to the first end marker after it', () => {
  const source = section('function toast(msg, err=false){', 'async function api(');
  assert.ok(source.startsWith('function toast(msg, err=false){'));
  assert.ok(html.slice(html.indexOf(source) + source.length).startsWith('async function api('));
  // the end marker need not be unique: the first one after the start ends the section
  assert.ok(html.split('\n}\n').length > 2);
  const body = section('function toast(msg, err=false){', '\n}\n');
  assert.ok(body.startsWith('function toast(msg, err=false){'));
  assert.ok(!body.includes('\n}\n'));
  assert.ok(source.startsWith(body));
});

test('section refuses a missing or repeated start marker and a missing end marker', () => {
  assert.throws(() => section('no such start marker', 'async function api('), /start marker not found: "no such start marker"/);
  assert.throws(() => section('function ', 'async function api('), /start marker occurs \d+ times: "function "/);
  assert.throws(() => section('function toast(msg, err=false){', 'no such end marker'), /end marker not found after "function toast\(msg, err=false\)\{": "no such end marker"/);
  // the marker that silently sliced the rest of the page (review R12)
  assert.throws(() => section('function renderGetStarted(){', '/* Control'), /end marker not found/);
});
