const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const WorkspaceStatus = require('../webui/workspace-status.js');
const {section} = require('./helpers.cjs');
const source = section('function accountSetupHtml(', 'async function renderSetup(){');

function setup(accounts = {}, post = async () => ({})) {
  const feedback = {textContent:''};
  const name = {value:'My Tower'};
  const controls = {'#account-feedback':feedback, '#account-name':name, '#account-select':{value:''}};
  const buttons = [{disabled:false}, {disabled:false}];
  const requests = [];
  const ctx = vm.createContext({
    S:{accounts, pending:new Map()},WorkspaceStatus,
    esc:s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c])),
    calibOk:() => false,
    $:key => controls[key] || null,
    document:{querySelectorAll:() => buttons},
    post:async (path, body) => { requests.push({path, body}); return post(path, body); },
    loadHomeData:async () => {}, loadStatus:async () => {}, renderSetup:async () => {},
  });
  vm.runInContext(source, ctx);
  return {ctx, feedback, name, controls, buttons, requests};
}

test('fresh setup has one named create action without an empty picker or import checkbox', () => {
  const {ctx} = setup({accounts:[], active:null, has_personal_settings:false});
  const rendered = vm.runInContext('accountSetupHtml()', ctx);
  assert.match(rendered, /profiles are not detected automatically/);
  assert.match(rendered, /value="My Tower"/);
  assert.match(rendered, /<form onsubmit=/);
  assert.match(rendered, /Create local profile/);
  assert.doesNotMatch(rendered, /id="account-select"|id="account-import"|id="account-tier"/);
});

test('a selected profile distinguishes saved settings from mapping and hides optional controls', () => {
  const {ctx} = setup({accounts:[{id:'main', label:'<My Tower>'}], active:'main', max_tier:1});
  const rendered = vm.runInContext('accountSetupHtml()', ctx);
  assert.match(rendered, /&lt;My Tower&gt;/);
  assert.match(rendered, /Profile saved\. Learn your game's screens next/);
  assert.match(rendered, /<details><summary>Manual tier setting \(optional\)/);
  assert.match(rendered, /<details><summary>Add another local profile/);
  assert.doesNotMatch(rendered, /id="account-select"|<details open/);
  ctx.calibOk = () => true;
  assert.match(vm.runInContext('accountSetupHtml()', ctx), /Screens learned for this emulator/);
});

test('multiple saved profiles remain selectable and imports require an explicit choice', () => {
  const {ctx} = setup({accounts:[{id:'one', label:'One'}, {id:'two', label:'Two'}], active:'two', has_personal_settings:true});
  const rendered = vm.runInContext('accountSetupHtml()', ctx);
  assert.match(rendered, /value="two" selected/);
  assert.match(rendered, /Switch saved profile/);
  assert.match(rendered, /id="account-import" type="checkbox">/);
  ctx.S.accounts.active = null;
  assert.match(vm.runInContext('accountSetupHtml()', ctx), /<details open><summary>Switch saved profile/);
});

test('a profile load failure is an error with retry, never an empty-account form', () => {
  const {ctx} = setup({error:'Server <unavailable>'});
  const rendered = vm.runInContext('accountSetupHtml()', ctx);
  assert.match(rendered, /role="alert"/);
  assert.match(rendered, /Server &lt;unavailable&gt;/);
  assert.match(rendered, /Retry loading profiles/);
  assert.doesNotMatch(rendered, /Create local profile|id="account-name"/);
});

test('creating a first profile needs no import control and sends no game actions', async () => {
  const {ctx, requests, buttons} = setup();
  await vm.runInContext('selectAccount(true)', ctx);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/accounts');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), {
    id:'my_tower', label:'My Tower', create:true, import_current:false,
  });
  assert.ok(buttons.every(button => !button.disabled));
});

test('duplicate submissions are blocked while saving; failures retain the name and allow retry', async () => {
  let rejectSave;
  const {ctx, requests, buttons, feedback, name} = setup({}, () => new Promise((resolve, reject) => { rejectSave = reject; }));
  const pending = vm.runInContext('selectAccount(true)', ctx);
  assert.ok(buttons.every(button => button.disabled));
  assert.equal(feedback.textContent, 'Creating local profile...');
  await vm.runInContext('selectAccount(true)', ctx);
  assert.equal(requests.length, 1);
  rejectSave(new Error('An account with that identifier already exists'));
  await pending;
  assert.match(feedback.textContent, /already exists/);
  assert.equal(name.value, 'My Tower');
  assert.ok(buttons.every(button => !button.disabled));
  assert.equal(ctx.S.accountBusy, false);
  ctx.post = async () => ({});
  await vm.runInContext('selectAccount(true)', ctx);
  assert.equal(ctx.S.accountBusy, false);
});

test('invalid names and missing selections give specific feedback without sending requests', async () => {
  const {ctx, name, feedback, requests} = setup();
  name.value = '   ';
  await vm.runInContext('selectAccount(true)', ctx);
  assert.match(feedback.textContent, /profile name/);
  await vm.runInContext('selectAccount()', ctx);
  assert.match(feedback.textContent, /Choose a saved profile/);
  assert.equal(requests.length, 0);
});
