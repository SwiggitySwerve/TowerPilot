const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Store, parseField, fieldHTML } = require("../webui/settings.js");
const payload = (revision = "r1", instance = "emu") => ({
  context: { instance, account: "a", profile: "p" },
  revision,
  modules: [
    { id: "tap", fields: [{ key: "pause", value: [15, 45] }] },
    { id: "loop", fields: [{ key: "seconds", value: 3 }] },
  ],
});
test("granular numbers and ranges retain exact values and reject invalid input", () => {
  assert.deepEqual(
    parseField({ type: "range", min: 0 }, ["15", "45"]),
    [15, 45],
  );
  assert.equal(parseField({ type: "number", min: 0 }, "0.125"), 0.125);
  for (const value of ["", "NaN", "Infinity", "-1"])
    assert.throws(() => parseField({ type: "number", min: 0 }, value));
  assert.throws(() => parseField({ type: "integer" }, "1.5"));
  assert.throws(() => parseField({ type: "range" }, ["45", "15"]));
});

test("preview source choices and installation paths preserve exact text and escape rendered markup", () => {
  const source = { key: "backend", label: "Preview source", type: "enum",
    options: [{ value: "auto", label: "Auto" }, { value: "mumu", label: "MuMu native" }] };
  assert.equal(parseField(source, "mumu"), "mumu");
  assert.throws(() => parseField(source, "unknown"), /listed option/);
  assert.throws(() => parseField(source, 0));
  assert.match(fieldHTML(source, "mumu", false), /value="mumu" selected>MuMu native/);
  const directory = { key: "mumu.install_dir", type: "string", label: "MuMu directory" };
  const path = 'C:\\MuMu & "custom"';
  assert.equal(parseField(directory, path), path);
  assert.equal(parseField(directory, ""), "");
  assert.throws(() => parseField(directory, null));
  assert.match(fieldHTML(directory, path, true), /type="text"[^]*disabled[^]*&amp; &quot;custom&quot;/);
});

test("emulator route mounts the preview module in the existing page without another navigation tree", () => {
  const vm = require("node:vm"), { section } = require("./helpers.cjs");
  const host = {}, calls = [];
  const S = { tab: "emulators" };
  const ctx = vm.createContext({ S, $: selector => selector === "#emulators-settings" ? host : null,
    settingsWorkspace: { mountPage: (element, options) => calls.push([element, options]) } });
  vm.runInContext(section("function mountConfigurationPage(){", '$("#app-sidebar").addEventListener("keydown"'), ctx);
  vm.runInContext("mountConfigurationPage();mountConfigurationPage()", ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], host);
  assert.deepEqual(Array.from(calls[0][1].moduleIds), ["device-preview"]);
  assert.equal(calls[0][1].policyModules, undefined);
});
test("switching modules preserves drafts; discarding only removes selected changes", () => {
  const s = new Store();
  s.accept(payload());
  s.change("tap", "pause", [20, 40]);
  s.change("loop", "seconds", 5);
  s.discard("tap");
  assert.deepEqual(s.values("tap").pause, [15, 45]);
  assert.equal(s.values("loop").seconds, 5);
});
test("save submits exact context and revision and preserves other module drafts", async () => {
  const s = new Store();
  s.accept(payload());
  s.change("tap", "pause", [15, 45.5]);
  s.change("loop", "seconds", 5);
  await s.save("tap", async (body) => {
    assert.deepEqual(body, {
      context: payload().context,
      revision: "r1",
      module: "tap",
      values: { pause: [15, 45.5] },
    });
    const p = payload("r2");
    p.modules[0].fields[0].value = [15, 45.5];
    return p;
  });
  assert.equal(s.payload.revision, "r2");
  assert.equal(s.drafts.has("tap"), false);
  assert.equal(s.values("loop").seconds, 5);
});
test("save failure keeps edits and exposes server error", async () => {
  const s = new Store();
  s.accept(payload());
  s.change("loop", "seconds", 5);
  await assert.rejects(
    s.save("loop", async () => {
      throw Error("Settings changed elsewhere.");
    }),
  );
  assert.equal(s.values("loop").seconds, 5);
  assert.equal(s.errors.get("loop"), "Settings changed elsewhere.");
  assert.equal(s.saving, false);
});
test("in-flight save never replaces a newly selected context", async () => {
  const s = new Store();
  s.accept(payload());
  s.change("loop", "seconds", 5);
  let finish;
  const saving = s.save("loop", () => new Promise((r) => (finish = r)));
  s.accept(payload("new", "other"));
  finish(payload("old"));
  await saving;
  assert.equal(s.payload.context.instance, "other");
  assert.equal(s.payload.revision, "new");
});
test("field rendering labels units, range endpoints, exact values, and escaped help", () => {
  const html = fieldHTML(
    {
      key: "tap.delay",
      path: "tap.delay",
      label: "Pause",
      type: "range",
      unit: "seconds",
      description: "<unsafe>",
      default: [15, 45],
    },
    [15, 45],
    false,
  );
  for (const text of [
    "Minimum",
    "Maximum",
    "seconds",
    'value="15"',
    'value="45"',
    "&lt;unsafe&gt;",
    "Default: 15 - 45",
  ])
    assert.ok(html.includes(text), text);
});
test("integer range metadata rejects fractional gem delay bounds", () => {
  assert.throws(() =>
    parseField({ type: "range", wholeNumbers: true }, ["15.5", "45"]),
  );
  assert.deepEqual(
    parseField({ type: "range", wholeNumbers: true }, ["15", "45"]),
    [15, 45],
  );
});
test("pair controls use a legend and independent endpoint labels", () => {
  const html = fieldHTML(
    { key: "delay", label: "Delay", type: "range" },
    [15, 45],
    false,
  );
  assert.ok(html.includes("<fieldset><legend>"));
  assert.equal((html.match(/<label>/g) || []).length, 2);
  assert.ok(
    !/<label>[^]*<label>/.test(html.replace(/<\/label>/g, "|").split("|")[0]),
  );
});
function mountHost() {
  const nodes = Object.fromEntries(
    ["nav", "content", "load", "existing", "search"].map((k) => [
      k,
      { innerHTML: "", textContent: "", value: "", children: [], append(child) { this.children.push(child); } },
    ]),
  );
  return {
    isConnected: true,
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    nodes,
    set innerHTML(value) {
      this.html = value;
      nodes.existing.children = [];
    },
    get innerHTML() { return this.html; },
    querySelector(selector) {
      const key = selector.match(
        /data-settings-(nav|content|load|existing|search)/,
      )?.[1];
      return key
        ? nodes[key]
        : selector.includes('data-settings-pane="setup-profile"')
          ? {}
          : null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

test("preview settings show their connection timing while other modules retain driver timing", async () => {
  const { create } = require("../webui/settings.js");
  const notice = "Saved changes apply on the next preview connection. No automation restart is needed.";
  const data = payload();
  data.modules.push({ id: "device-preview", title: "Video preview", scope: "instance", editable: true,
    apply_notice: notice, fields: [{ key: "fps", type: "number", value: 15 }] });
  const host = mountHost(), view = create({ get: async () => data });
  view.mountPage(host, { moduleIds: ["device-preview"] });
  await new Promise(setImmediate);
  assert.match(host.nodes.content.innerHTML, /Emulator: emu/);
  assert.ok(host.nodes.content.innerHTML.includes(notice));
  assert.doesNotMatch(host.nodes.content.innerHTML, /next driver start|Restarting automation is a separate action/);
  view.mountPage(host, { moduleIds: ["loop"] });
  assert.match(host.nodes.content.innerHTML, /Saved changes apply on the next driver start/);
  data.modules.find(m => m.id === "device-preview").apply_notice = "<custom notice>";
  view.mountPage(host, { moduleIds: ["device-preview"] });
  await new Promise(setImmediate);
  assert.match(host.nodes.content.innerHTML, /&lt;custom notice&gt;/);
  assert.doesNotMatch(host.nodes.content.innerHTML, /<custom notice>/);
});
test("controller groups policy modules, switches selected policy, and blocks changed-context drafts", async () => {
  const { create } = require("../webui/settings.js");
  let current = {
    context: { instance: "one", profile: "farm" },
    revision: "r",
    modules: [
      ...["first", "second"].map((name) => ({
        id: "ad:" + name,
        title: name,
        group: "Ad Gems",
        scope: "profile",
        editable: true,
        fields: [{ key: "delay", type: "range", value: [15, 45] }],
      })),
    ],
  };
  const view = create({
      get: async () => current,
      post: async () => {
        throw Error("must not save conflict");
      },
    }),
    host = mountHost();
  view.mount(host);
  await new Promise(setImmediate);
  view.select("ad:first");
  assert.equal(
    (host.nodes.nav.innerHTML.match(/data-settings-select="ad:/g) || []).length,
    1,
  );
  assert.ok(
    host.nodes.content.innerHTML.includes("data-settings-policy-select"),
  );
  host.onchange({
    target: {
      matches: (s) => s === "[data-settings-policy-select]",
      value: "ad:second",
    },
  });
  assert.ok(
    host.nodes.content.innerHTML.includes('value="ad:second" selected'),
  );
  view.store.change("ad:second", "delay", [20, 40]);
  current = { ...current, context: { instance: "two", profile: "other" } };
  await view.load();
  assert.equal(view.store.payload.context.instance, "one");
  assert.deepEqual(view.store.values("ad:second").delay, [20, 40]);
  assert.ok(host.nodes.load.innerHTML.includes("active context changed"));
  assert.ok(host.nodes.load.innerHTML.includes("Discard all drafts"));
  assert.ok(
    host.nodes.content.innerHTML.includes('data-field="delay" disabled'),
  );
  let prevented = false;
  await host.onsubmit({
    target: { matches: () => true },
    preventDefault() {
      prevented = true;
    },
  });
  assert.ok(prevented);
});
test("dashboard settings save refuses older staged edits and refreshes profile cache before resolving", async () => {
  const vm = require("node:vm"),
    { section } = require("./helpers.cjs");
  let options;
  const calls = [];
  const ctx = vm.createContext({
    TowerSettings: {
      create(value) {
        options = value;
        return {};
      },
    },
    S: { pending: new Map([["old", {}]]) },
    post: async () => {
      calls.push("post");
      return { revision: "new" };
    },
    loadHomeData: async () => calls.push("load"),
    refreshWorkspaceStatus: async () => calls.push("workspace"),
  });
  vm.runInContext(
    section(
      "const settingsWorkspace = TowerSettings.create({",
      "function accountSetupHtml(",
    ),
    ctx,
  );
  await assert.rejects(options.post({}), /Save or discard/);
  assert.deepEqual(calls, []);
  ctx.S.pending.clear();
  assert.equal((await options.post({})).revision, "new");
  assert.deepEqual(calls, ["post", "load", "workspace"]);
});
test("invalid raw fields stay dirty, survive redraws, block save, and discard clears validation", async () => {
  const { create } = require("../webui/settings.js");
  const p = payload();
  p.modules[0].fields[0] = {
    key: "pause",
    label: "Pause",
    type: "range",
    value: [15, 45],
  };
  p.modules[0].editable = true;
  p.modules[0].scope = "machine";
  const view = create({
      get: async () => p,
      post: async () => {
        throw Error("must not send invalid draft");
      },
    }),
    host = mountHost();
  view.mount(host);
  await new Promise(setImmediate);
  view.select("tap");
  view.store.raw("tap", "pause", ["", "45"], "Enter a number.");
  view.select("loop");
  view.select("tap");
  assert.deepEqual(view.store.displayValues("tap").pause, ["", "45"]);
  assert.ok(view.store.dirty());
  assert.ok(view.store.invalid("tap"));
  assert.ok(host.nodes.content.innerHTML.includes('value=""'));
  assert.match(host.nodes.content.innerHTML, /type="submit" disabled/);
  await assert.rejects(
    view.store.save("tap", async () => {}),
    /highlighted/,
  );
  view.store.change("tap", "pause", [16, 45]);
  assert.equal(view.store.invalid("tap"), false);
  view.store.raw("tap", "pause", ["", "45"], "Enter a number.");
  view.store.discard("tap");
  assert.equal(view.store.dirty(), false);
  assert.equal(view.store.invalid("tap"), false);
  assert.deepEqual(view.store.displayValues("tap").pause, [15, 45]);
});
test("same-context external revision preserves old drafts and exposes explicit reload recovery", async () => {
  const { create } = require("../webui/settings.js");
  let current = payload();
  current.modules[0].fields[0].type = "range";
  current.modules[0].editable = true;
  current.modules[0].scope = "machine";
  const view = create({ get: async () => current }),
    host = mountHost();
  view.mount(host);
  await new Promise(setImmediate);
  view.select("tap");
  view.store.change("tap", "pause", [20, 40]);
  current = { ...current, revision: "r2" };
  await view.load();
  assert.equal(view.store.payload.revision, "r1");
  assert.deepEqual(view.store.values("tap").pause, [20, 40]);
  assert.match(host.nodes.load.innerHTML, /changed elsewhere/);
  assert.match(host.nodes.load.innerHTML, /Discard all drafts/);
  assert.match(host.nodes.content.innerHTML, /type="submit" disabled/);
});
test("fractional controls accept precise decimals despite stale step metadata", () => {
  const html = fieldHTML(
    { key: "jitter", label: "Jitter", type: "number", step: 0.1 },
    0.03,
    false,
  );
  assert.match(html, /step="any"/);
  const whole = fieldHTML(
    {
      key: "delay",
      label: "Delay",
      type: "range",
      wholeNumbers: true,
      step: 0.1,
    },
    [15, 45],
    false,
  );
  assert.equal((whole.match(/step="1"/g) || []).length, 2);
});
const { create } = require("../webui/settings.js");
test("external Settings navigation owns search and selection across repeated mounts", async () => {
  const view = create({ get: async () => payload() });
  const host = mountHost(), first = mountHost(), second = mountHost();
  const pane = { id: "setup-tools", dataset: {} };
  const querySelector = host.querySelector.bind(host);
  host.querySelector = (selector) => selector === '[data-settings-pane="setup-tools"]'
    ? pane : querySelector(selector);
  host.nodes.existing.children.push(pane);
  view.mount(host, first);
  await new Promise(setImmediate);
  assert.ok(!host.innerHTML.includes('<aside'));
  assert.match(first.innerHTML, /data-settings-search/);
  assert.match(first.nodes.nav.innerHTML, /Emulator connection/);
  assert.doesNotMatch(first.nodes.nav.innerHTML, /data-settings-select="(?:equipment|schedule|screens)-link"/);
  first.oninput({ target: {
    value: "Connection tools", dataset: {},
    matches: (selector) => selector === "[data-settings-search]",
  } });
  assert.match(first.nodes.nav.innerHTML, /Connection tools/);
  assert.ok(!first.nodes.nav.innerHTML.includes("Emulator connection"));
  const click = { target: { closest: () => ({
    dataset: { settingsSelect: "setup-tools" }, hasAttribute: () => false,
  }) } };
  first.onclick(click);
  view.mount(host, second);
  await new Promise(setImmediate);
  assert.equal(first.oninput, null);
  assert.equal(first.onclick, null);
  assert.equal(first.innerHTML, "");
  assert.equal(second.nodes.search.value, "Connection tools");
  assert.match(second.nodes.nav.innerHTML, /settings-selected[^]*data-settings-select="setup-tools"/);
  assert.equal(host.nodes.existing.children.filter((child) => child === pane).length, 1);
  view.mount(host);
  await new Promise(setImmediate);
  assert.equal(second.onclick, null);
  assert.match(host.innerHTML, /<aside class="settings-sidebar">/);
  assert.equal(host.nodes.search.value, "Connection tools");
});

test("late settings responses tolerate a cleared, still-attached panel", async () => {
  for (const fail of [false, true]) {
    let deferred;
    const view = create({ get: () => deferred || Promise.resolve(payload()) });
    const host = mountHost(), nav = mountHost();
    view.mount(host, nav);
    await new Promise(setImmediate);
    let resolve, reject;
    deferred = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = view.load();
    const querySelector = host.querySelector.bind(host);
    host.querySelector = () => null;
    if (fail) reject(new Error("Connection interrupted"));
    else resolve(payload());
    await assert.doesNotReject(pending);
    host.querySelector = querySelector;
    deferred = null;
    view.mount(host, nav);
    await new Promise(setImmediate);
    assert.match(nav.nodes.nav.innerHTML, /Emulator connection/);
    assert.equal(host.nodes.load.textContent, "");
  }
});

test("reentry during a pending settings read renders into the new mount", async () => {
  let deferred;
  const view = create({ get: () => deferred || Promise.resolve(payload()) });
  const first = mountHost(), second = mountHost(), nav = mountHost();
  view.mount(first, nav);
  await new Promise(setImmediate);
  let resolve;
  deferred = new Promise(yes => { resolve = yes; });
  const pending = view.load();
  first.querySelector = () => null;
  view.mount(second, nav);
  resolve(payload());
  await pending;
  assert.match(nav.nodes.nav.innerHTML, /Emulator connection/);
  assert.equal(second.nodes.load.textContent, "");
});

const pagePayload = (revision = "r1") => ({
  ...payload(revision),
  modules: [
    ...payload(revision).modules,
    { id: "rewards", title: "Global rewards", fields: [{ key: "enabled", type: "boolean", value: false }] },
    ...["first", "second"].flatMap(name => ["ad", "orbit", "gather"].map(family => ({
      id: `${family}:${name}`, title: `${family} \u00b7 ${name === "first" ? "Farm policy" : "Tournament policy"}`,
      description: "Shared gathering policy. Runs: Coin run", group: family,
      fields: [{ key: "enabled", type: "boolean", value: false }],
    }))),
  ].map(m => ({ ...m, fields: m.fields.map(f => ({ ...f, type: f.type || (Array.isArray(f.value) ? "range" : "number") })), editable: true, scope: "profile", title: m.title || m.id })),
});
const flush = () => new Promise(setImmediate);
const collectionPage = { moduleIds: ["rewards"], policyModules: ["ad", "orbit", "gather"] };
const submitModule = (host, id) => host.onsubmit({
  target: { matches: () => true, dataset: { settingsModule: id } },
  preventDefault() {},
});
test("collection page has simultaneous forms and one shared policy selector with metadata labels", async () => {
  const host = mountHost(), view = create({ get: async () => pagePayload() });
  view.mountPage(host, collectionPage);
  await flush();
  assert.doesNotMatch(host.innerHTML, /<aside|data-settings-nav|data-settings-search/);
  assert.equal((host.nodes.content.innerHTML.match(/data-settings-form /g) || []).length, 4);
  assert.equal((host.nodes.content.innerHTML.match(/data-settings-page-policy/g) || []).length, 1);
  assert.match(host.nodes.content.innerHTML, />Farm policy<\/option>/);
  assert.match(host.nodes.content.innerHTML, /Runs: Coin run/);
  for (const id of ["rewards", "ad:first", "orbit:first", "gather:first"])
    assert.ok(host.nodes.content.innerHTML.includes(`id="settings-module-${id}"`));
  view.store.change("ad:first", "enabled", true);
  host.onchange({ target: { matches: s => s === "[data-settings-page-policy]", value: "second" } });
  for (const family of ["ad", "orbit", "gather"])
    assert.ok(host.nodes.content.innerHTML.includes(`data-settings-module="${family}:second"`));
  view.select("ad:first");
  assert.equal(view.store.values("ad:first").enabled, true);
  assert.match(host.nodes.content.innerHTML, /value="first" selected/);
});
test("page saves route by submitting form, refresh revision, preserve other drafts and show failures", async () => {
  let current = pagePayload();
  const calls = [];
  const view = create({ get: async () => current, post: async body => {
    calls.push(body);
    if (body.module === "tap") throw Error("Write failed");
    current = pagePayload("r2");
    current.modules.find(m => m.id === body.module).fields[0].value = body.values.seconds;
    return current;
  } }), host = mountHost();
  view.mountPage(host, { moduleIds: ["loop", "tap"] });
  await flush();
  view.store.change("loop", "seconds", 7);
  view.store.change("tap", "pause", [20, 40]);
  await submitModule(host, "loop");
  assert.equal(calls[0].module, "loop");
  assert.equal(view.store.payload.revision, "r2");
  assert.deepEqual(view.store.values("tap").pause, [20, 40]);
  assert.equal(view.store.dirty("loop"), false);
  await submitModule(host, "tap");
  assert.equal(calls[1].revision, "r2");
  assert.equal(calls[1].module, "tap");
  assert.match(host.nodes.content.innerHTML, /Write failed/);
  assert.deepEqual(view.store.values("tap").pause, [20, 40]);
});
test("page raw invalid drafts and conflicts survive departure and prevent submission", async () => {
  let current = pagePayload(), posts = 0;
  const view = create({ get: async () => current, post: async () => { posts++; } });
  const first = mountHost(), second = mountHost();
  view.mountPage(first, { moduleIds: ["tap"] });
  await flush();
  view.store.raw("tap", "pause", ["", "45"], "Enter a number.");
  view.unmount();
  assert.equal(first.innerHTML, "");
  assert.equal(first.onsubmit, null);
  view.mountPage(second, { moduleIds: ["tap", "loop"] });
  await flush();
  assert.match(second.nodes.content.innerHTML, /value=""/);
  await submitModule(second, "tap");
  assert.equal(posts, 0);
  current = pagePayload("external");
  await view.load();
  assert.match(second.nodes.load.innerHTML, /changed elsewhere/);
  await submitModule(second, "loop");
  assert.equal(posts, 0);
  assert.deepEqual(view.store.displayValues("tap").pause, ["", "45"]);
});
test("page late reads and saves tolerate departure and update the new workspace only", async () => {
  for (const fail of [false, true]) {
    let finish, reject, pendingRead;
    const view = create({ get: () => pendingRead || Promise.resolve(pagePayload()) });
    const first = mountHost(), second = mountHost();
    view.mountPage(first, collectionPage);
    await flush();
    pendingRead = new Promise((resolve, no) => { finish = resolve; reject = no; });
    const reading = view.load();
    view.unmount();
    view.mountPage(second, { moduleIds: ["loop"] });
    if (fail) reject(Error("Disconnected")); else finish(pagePayload());
    await assert.doesNotReject(reading);
    assert.equal(first.innerHTML, "");
    assert.match(second.nodes.content.innerHTML, /data-settings-module="loop"/);
    if (fail) assert.match(second.nodes.load.innerHTML, /Disconnected/);
  }
});

test("simultaneous form edits and discard use their own module even when field keys match", async () => {
  const view = create({ get: async () => pagePayload() }), host = mountHost();
  view.mountPage(host, collectionPage);
  await flush();
  const status = {}, save = {}, discard = {};
  const bar = { querySelector: selector => selector === "[role=status]" ? status : selector === "[type=submit]" ? save : discard, querySelectorAll: () => [save, discard] };
  const error = { dataset: { fieldError: "enabled" } };
  const control = { dataset: { field: "enabled" }, setCustomValidity() {} };
  const form = {
    dataset: { settingsModule: "orbit:first" },
    querySelector: () => bar,
    querySelectorAll: selector => selector === "[data-field]" ? [control] : [error],
  };
  host.onchange({ target: {
    dataset: { field: "enabled" }, checked: true,
    closest: () => form, matches: () => false,
  } });
  assert.equal(view.store.values("orbit:first").enabled, true);
  assert.equal(view.store.values("ad:first").enabled, false);
  view.store.change("ad:first", "enabled", true);
  host.onclick({ target: { closest: () => ({
    dataset: {}, hasAttribute: name => name === "data-settings-discard", closest: () => form,
  }) } });
  assert.equal(view.store.dirty("orbit:first"), false);
  assert.equal(view.store.dirty("ad:first"), true);
});

test("pending page save completes after unmount without restoring departed markup", async () => {
  let finish;
  const view = create({ get: async () => pagePayload(), post: () => new Promise(resolve => { finish = resolve; }) });
  const host = mountHost();
  view.mountPage(host, { moduleIds: ["loop"] });
  await flush();
  view.store.change("loop", "seconds", 8);
  const saving = submitModule(host, "loop");
  view.unmount();
  const saved = pagePayload("r2");
  saved.modules.find(m => m.id === "loop").fields[0].value = 8;
  finish(saved);
  await assert.doesNotReject(saving);
  assert.equal(host.innerHTML, "");
  assert.equal(view.store.payload.revision, "r2");
  assert.equal(view.store.values("loop").seconds, 8);
  assert.equal(view.store.dirty(), false);
});

test("older pending read cannot replace revision returned by a page save", async () => {
  let finishRead, defer = false;
  const view = create({
    get: () => defer ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve(pagePayload()),
    post: async () => {
      const saved = pagePayload("r2");
      saved.modules.find(m => m.id === "loop").fields[0].value = 8;
      return saved;
    },
  }), host = mountHost();
  view.mountPage(host, { moduleIds: ["loop"] });
  await flush();
  view.store.change("loop", "seconds", 8);
  defer = true;
  const reading = view.load();
  await submitModule(host, "loop");
  finishRead(pagePayload("r1"));
  await reading;
  assert.equal(view.store.payload.revision, "r2");
  assert.equal(view.store.values("loop").seconds, 8);
});
