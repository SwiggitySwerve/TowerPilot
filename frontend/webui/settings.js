(function (root, factory) {
  const api = factory();
  if (typeof module === "object") module.exports = api;
  else root.TowerSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function parseField(field, raw) {
    if (field.type === "boolean") return !!raw;
    const number = (value) => {
      if (String(value).trim() === "") throw Error("Enter a number.");
      const n = Number(value);
      if (!Number.isFinite(n)) throw Error("Enter a finite number.");
      if (
        (field.type === "integer" || field.wholeNumbers) &&
        !Number.isInteger(n)
      )
        throw Error("Enter a whole number.");
      if (field.min != null && n < field.min)
        throw Error(`Minimum: ${field.min}.`);
      if (field.max != null && n > field.max)
        throw Error(`Maximum: ${field.max}.`);
      return n;
    };
    if (field.type === "range" || field.type === "point") {
      const pair = raw.map(number);
      if (pair.length !== 2) throw Error("Enter two numbers.");
      if (field.type === "range" && pair[0] > pair[1])
        throw Error("Minimum must not exceed maximum.");
      return pair;
    }
    return number(raw);
  }
  class Store {
    constructor() {
      this.payload = null;
      this.drafts = new Map();
      this.raws = new Map();
      this.validation = new Map();
      this.errors = new Map();
      this.saving = false;
      this.sequence = 0;
    }
    accept(payload) {
      if (this.payload && !same(payload.context, this.payload.context)) {
        this.drafts.clear();
        this.errors.clear();
        this.raws.clear();
        this.validation.clear();
      }
      this.payload = clone(payload);
    }
    values(id) {
      const m = this.payload.modules.find((m) => m.id === id);
      return (
        this.drafts.get(id) ||
        Object.fromEntries(m.fields.map((f) => [f.key, clone(f.value)]))
      );
    }
    dirty(id) {
      return id === undefined
        ? this.drafts.size + this.raws.size > 0
        : this.drafts.has(id) || this.raws.has(id);
    }
    displayValues(id) {
      return { ...this.values(id), ...(this.raws.get(id) || {}) };
    }
    invalid(id) {
      return Object.keys(this.validation.get(id) || {}).length > 0;
    }
    raw(id, key, value, error) {
      this.raws.set(id, { ...(this.raws.get(id) || {}), [key]: clone(value) });
      this.validation.set(id, {
        ...(this.validation.get(id) || {}),
        [key]: error,
      });
    }
    clearRaw(id, key) {
      for (const map of [this.raws, this.validation]) {
        const row = map.get(id);
        if (row) {
          delete row[key];
          if (!Object.keys(row).length) map.delete(id);
        }
      }
    }
    change(id, key, value) {
      this.clearRaw(id, key);
      const values = clone(this.values(id));
      values[key] = value;
      const original = Object.fromEntries(
        this.payload.modules
          .find((m) => m.id === id)
          .fields.map((f) => [f.key, f.value]),
      );
      if (same(values, original)) this.drafts.delete(id);
      else this.drafts.set(id, values);
      this.errors.delete(id);
    }
    discard(id) {
      this.drafts.delete(id);
      this.errors.delete(id);
      this.raws.delete(id);
      this.validation.delete(id);
    }
    async save(id, request) {
      if (this.saving) return;
      if (this.invalid(id))
        throw Error("Correct the highlighted fields before saving.");
      this.saving = true;
      const submitted = clone(this.values(id));
      const context = clone(this.payload.context);
      try {
        const payload = await request({
          context,
          revision: this.payload.revision,
          module: id,
          values: submitted,
        });
        if (!same(context, this.payload.context)) return;
        // A read started before this write completed must not restore its old revision.
        ++this.sequence;
        this.accept(payload);
        if (same(this.drafts.get(id), submitted)) this.drafts.delete(id);
        this.errors.delete(id);
      } catch (e) {
        this.errors.set(id, e.message);
        throw e;
      } finally {
        this.saving = false;
      }
    }
  }
  const builtins = [
    { id: "setup-profile", title: "Profile", group: "Setup" },
    { id: "setup-connection", title: "Emulator connection", group: "Setup" },
    { id: "setup-tools", title: "Connection tools", group: "Setup" },
    { id: "run-policies", title: "Run policies", group: "Run configuration" },
    {
      id: "equipment-link",
      title: "Equipment",
      group: "Run configuration",
      tab: "equipment",
    },
    {
      id: "schedule-link",
      title: "Schedule",
      group: "Run configuration",
      tab: "schedule",
    },
    {
      id: "screens-link",
      title: "Screen recognition",
      group: "Run configuration",
      tab: "screens",
    },
  ];
  function fieldHTML(f, value, disabled) {
    const key = esc(f.key),
      attrs = `data-field="${key}" ${disabled ? "disabled" : ""}`;
    const number = (v, index) =>
      `<input type="number" ${attrs} ${index == null ? "" : `data-index="${index}"`} value="${esc(v)}" step="${f.type === "integer" || f.wholeNumbers ? 1 : "any"}" ${f.min == null ? "" : `min="${f.min}"`} ${f.max == null ? "" : `max="${f.max}"`}>`;
    const paired = f.type === "range" || f.type === "point";
    const input =
      f.type === "boolean"
        ? `<input type="checkbox" ${attrs} ${value ? "checked" : ""}>`
        : f.type === "range" || f.type === "point"
          ? `<div class="settings-pair">${value.map((v, i) => `<label>${f.type === "range" ? (i ? "Maximum" : "Minimum") : i ? "Y" : "X"}${number(v, i)}</label>`).join("")}</div>`
          : number(value);
    const title = `<strong>${esc(f.label)}</strong>${f.unit ? ` <span class="muted">(${esc(f.unit)})</span>` : ""}`;
    const control = paired
      ? `<fieldset><legend>${title}</legend>${input}</fieldset>`
      : `<label>${f.type === "boolean" ? input : ""}${title}${f.type === "boolean" ? "" : input}</label>`;
    return `<div class="settings-field">${control}<p class="muted">${esc(f.description || "")}</p><small class="muted">${esc(f.path)}${f.default === undefined ? "" : ` | Default: ${esc(Array.isArray(f.default) ? f.default.join(" - ") : f.default)}`}</small><span data-field-error="${key}" role="alert"></span></div>`;
  }
  function navigationModules(modules) {
    const seen = new Set();
    return modules
      .map((m) => {
        if (!m.id.includes(":")) return m;
        if (seen.has(m.group)) return null;
        seen.add(m.group);
        return { ...m, title: m.group };
      })
      .filter(Boolean);
  }
  function create(options) {
    const store = new Store();
    let host = null,
      navigationHost = null,
      active = "setup-profile",
      query = "",
      loadError = "",
      loading = false,
      contextConflict = false,
      page = null,
      policy = "";
    const modules = () => [...builtins, ...(store.payload?.modules || [])];
    // The router keeps the panel element attached while removing its contents.
    // A pending read may finish after departure, so attachment alone is not a mount.
    const mounted = () => host?.isConnected && !!host.querySelector("[data-settings-content]");
    function select(id) {
      active = id;
      if (page && id.includes(":")) policy = id.slice(id.indexOf(":") + 1);
      render();
      if (page) host?.querySelector(`[id="settings-module-${id}"]`)?.scrollIntoView?.({ block: "start" });
    }
    function render() {
      if (!mounted()) return;
      if (page) { renderPage(); return; }
      const nav = navigationHost.querySelector("[data-settings-nav]"),
        content = host.querySelector("[data-settings-content]");
      const matching = modules().filter((m) => (navigationHost === host || !m.tab)).filter((m) =>
        [
          m.title,
          m.description,
          m.group,
          ...(m.fields || []).flatMap((f) => [f.label, f.path, f.description]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      const filtered = navigationModules(matching);
      nav.innerHTML =
        [...new Set(filtered.map((m) => m.group))]
          .map(
            (group) =>
              `<div class="settings-nav-group"><h3>${esc(group)}</h3>${filtered
                .filter((m) => m.group === group)
                .map(
                  (m) =>
                    `<button class="ghost ${active === m.id || (m.id.includes(":") && modules().find((x) => x.id === active)?.group === m.group) ? "settings-selected" : ""}" data-settings-select="${esc(m.id)}" aria-current="${active === m.id || (m.id.includes(":") && modules().find((x) => x.id === active)?.group === m.group) ? "page" : "false"}">${esc(m.title)}${store.dirty(m.id) ? " •" : ""}</button>`,
                )
                .join("")}</div>`,
          )
          .join("") || "<p>No settings match.</p>";
      for (const pane of host.querySelectorAll("[data-settings-pane]"))
        pane.hidden = pane.dataset.settingsPane !== active;
      content.hidden = !!host.querySelector(`[data-settings-pane="${active}"]`);
      if (content.hidden) return;
      const item = modules().find((m) => m.id === active);
      if (!item) {
        content.innerHTML = "<p>Select a setting.</p>";
        return;
      }
      if (item.tab) {
        content.innerHTML = `<h2>${esc(item.title)}</h2><p>Open the ${esc(item.title.toLowerCase())} workspace to configure it.</p><a href="#${item.tab}" role="button">Open ${esc(item.title)}</a>`;
        return;
      }
      if (item.id === "run-policies") {
        content.innerHTML = `<h2>Shared run policies</h2><p>Changes affect every run using that policy. Policy editors keep their own Save and Discard controls. Changes apply on the next driver start.</p>${(store.payload?.policies || []).map((p, i) => `<button class="ghost" data-policy="${i}">${esc(p.title)}</button>`).join("")}<p><a href="#runs">Manage runs and policy assignments</a></p>`;
        return;
      }
      const peers = item.id.includes(":")
        ? (store.payload.modules || []).filter((m) => m.group === item.group)
        : [];
      const selector = peers.length
        ? `<label>Shared policy<select data-settings-policy-select>${peers.map((m) => `<option value="${esc(m.id)}" ${m.id === active ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label>`
        : "";
      content.innerHTML = moduleHTML(item, peers.length ? item.group : item.title, selector);
      validateForms();
    }
    function moduleHTML(item, title = item.title, selector = "") {
      const scope =
        item.scope === "machine"
          ? "This computer"
          : item.scope === "instance"
            ? `Emulator: ${store.payload.context.instance}`
            : `Shared profile: ${store.payload.context.profile}`;
      return `<h2>${esc(title)}</h2>${selector}<p>${esc(item.description)}</p><p class="settings-scope">${esc(scope)}</p>${item.affected_runs ? `<p>Affected runs: ${esc(item.affected_runs.join(", ") || "None")}</p>` : ""}<p class="muted">Saved changes apply on the next driver start. Restarting automation is a separate action.</p>${!item.editable ? '<p role="status">Select an editable profile to change these settings.</p>' : ""}<form data-settings-form data-settings-module="${esc(item.id)}">${item.fields.map((f) => fieldHTML(f, store.displayValues(item.id)[f.key], !item.editable || store.saving || contextConflict)).join("")}<div class="settings-save"><span role="status">${esc(store.errors.get(item.id) || (store.dirty(item.id) ? "Unsaved changes" : "Saved"))}</span><button type="submit" ${!item.editable || !store.dirty(item.id) || store.saving || contextConflict || store.invalid(item.id) ? "disabled" : ""}>${store.saving ? "Saving…" : "Save changes"}</button><button type="button" class="ghost" data-settings-discard ${!store.dirty(item.id) || store.saving ? "disabled" : ""}>Discard</button></div></form>`;
    }
    function validateForms() {
      for (const form of host.querySelectorAll("[data-settings-form]")) {
        const id = form.dataset.settingsModule;
        for (const control of form.querySelectorAll("[data-field]")) {
          const error = store.validation.get(id)?.[control.dataset.field] || "";
          control.setCustomValidity(error);
          const note = Array.from(form.querySelectorAll("[data-field-error]"))
            .find((n) => n.dataset.fieldError === control.dataset.field);
          if (note) note.textContent = error;
        }
      }
    }
    function renderPage() {
      const content = host.querySelector("[data-settings-content]");
      const available = store.payload?.modules || [];
      const families = page.policyModules || [];
      const choices = available.filter((m) => families.includes(m.id.split(":")[0]) && m.id.includes(":"));
      const suffixes = [...new Set(choices.map((m) => m.id.slice(m.id.indexOf(":") + 1)))];
      if (!suffixes.includes(policy)) policy = suffixes[0] || "";
      const label = (suffix) => {
        const item = choices.find((m) => m.id === "gather:" + suffix) || choices.find((m) => m.id.endsWith(":" + suffix));
        return item.title.split(" \u00b7 ").slice(1).join(" \u00b7 ") || item.title;
      };
      const selector = suffixes.length
        ? '<label class="settings-shared-policy">Shared collection policy<select data-settings-page-policy>' + suffixes.map((suffix) => '<option value="' + esc(suffix) + '" ' + (suffix === policy ? "selected" : "") + '>' + esc(label(suffix)) + '</option>').join("") + '</select></label><p class="muted">Changes affect every run using the selected shared policy.</p>'
        : families.length && store.payload ? "<p>No shared collection policies are available in this profile.</p>" : "";
      const ids = [...(page.moduleIds || []), ...families.map((family) => family + ":" + policy)];
      content.innerHTML = selector + ids.map((id) => {
        const item = available.find((m) => m.id === id);
        return item ? '<section class="settings-module" id="settings-module-' + esc(id) + '">' + moduleHTML(item) + '</section>' : "";
      }).join("");
      validateForms();
    }
    async function load() {
      if (loading) return;
      loading = true;
      const seq = ++store.sequence;
      try {
        if (mounted())
          host.querySelector("[data-settings-load]").textContent =
            "Loading settings...";
        const payload = await options.get();
        if (seq !== store.sequence) return;
        if (store.dirty()) {
          if (!same(payload.context, store.payload.context)) {
            contextConflict = true;
            loadError =
              "Your active context changed. These drafts belong to " +
              JSON.stringify(store.payload.context) +
              ". Discard all drafts to load the active context.";
          } else if (payload.revision !== store.payload.revision) {
            contextConflict = true;
            loadError =
              "Settings changed elsewhere. Your drafts are preserved at the earlier revision. Discard all drafts and reload before editing the latest settings.";
          } else {
            contextConflict = false;
            loadError = "";
            if (mounted())
              host.querySelector("[data-settings-load]").textContent =
                "Drafts preserved.";
          }
          return;
        }
        store.accept(payload);
        contextConflict = false;
        loadError = "";
        if (mounted())
          host.querySelector("[data-settings-load]").textContent = "";
      } catch (e) {
        loadError = e.message;
      } finally {
        loading = false;
        render();
        if (loadError && mounted()) {
          const note = host.querySelector("[data-settings-load]");
          note.innerHTML = `<span role="alert">${esc(loadError)}</span> <button class="ghost" data-settings-retry>Retry settings</button>${store.dirty() ? '<button class="ghost" data-settings-discard-all>Discard all drafts and reload</button>' : ""}`;
        }
      }
    }
    function mount(element, navigationElement = null, pageOptions = null) {
      page = pageOptions;
      if (navigationHost && navigationHost !== host) {
        navigationHost.oninput = null;
        navigationHost.onclick = null;
        navigationHost.innerHTML = "";
        navigationHost.classList.remove("settings-sidebar", "settings-sidebar-external");
      }
      host = element;
      host.classList.add("settings-shell");
      host.classList.toggle("settings-shell-external", !!navigationElement || !!page);
      host.classList.toggle("settings-page", !!page);
      const previous = host.querySelector("[data-settings-existing]");
      const existing = Array.from(previous ? previous.children : host.children);
      const navigation = '<h2>Settings</h2><label>Search settings<input type="search" data-settings-search placeholder="Find a setting..."></label><nav data-settings-nav aria-label="Settings categories"></nav>';
      host.innerHTML =
        (navigationElement || page ? "" : `<aside class="settings-sidebar">${navigation}</aside>`) + '<div class="settings-main"><div data-settings-load role="status"></div><section data-settings-content></section><div data-settings-existing></div></div>';
      navigationHost = navigationElement || host;
      if (navigationElement) {
        navigationElement.classList.add("settings-sidebar", "settings-sidebar-external");
        navigationElement.innerHTML = navigation;
      }
      const box = host.querySelector("[data-settings-existing]");
      for (const child of existing) {
        if (child.id === "setup-journey" || child.id === "workspace-operation")
          child.dataset.settingsPane = "setup-profile";
        else if (child.id.startsWith("setup-"))
          child.dataset.settingsPane = child.id;
        box.append(child);
      }
      if (!page) navigationHost.querySelector("[data-settings-search]").value = query;
      host.oninput = (e) => {
        if (e.target.dataset.field) {
          host.onchange(e);
          return;
        }
        if (e.target.matches("[data-settings-search]")) {
          query = e.target.value;
          render();
        }
      };
      host.onchange = (e) => {
        if (e.target.matches("[data-settings-page-policy]")) {
          policy = e.target.value;
          render();
          return;
        }
        if (e.target.matches("[data-settings-policy-select]")) {
          select(e.target.value);
          return;
        }
        if (!e.target.dataset.field) return;
        const form = e.target.closest?.("[data-settings-form]") || host,
          id = form.dataset?.settingsModule || active;
        const item = store.payload.modules.find((m) => m.id === id),
          f = item.fields.find((f) => f.key === e.target.dataset.field);
        const controls = Array.from(
          form.querySelectorAll("[data-field]"),
        ).filter((c) => c.dataset.field === f.key);
        const raw =
          f.type === "boolean"
            ? e.target.checked
            : f.type === "range" || f.type === "point"
              ? controls.map((c) => c.value)
              : e.target.value;
        const err = Array.from(
          form.querySelectorAll("[data-field-error]"),
        ).find((c) => c.dataset.fieldError === f.key);
        try {
          const value = parseField(f, raw);
          controls.forEach((control) => control.setCustomValidity(""));
          err.textContent = "";
          store.change(id, f.key, value);
          const bar = form.querySelector(".settings-save");
          bar.querySelector("[role=status]").textContent = "Unsaved changes";
          bar
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = store.saving));
        } catch (error) {
          store.raw(id, f.key, raw, error.message);
          controls.forEach((control) =>
            control.setCustomValidity(error.message),
          );
          err.textContent = error.message;
        }
        const bar = form.querySelector(".settings-save");
        bar.querySelector("[type=submit]").disabled =
          store.saving ||
          contextConflict ||
          store.invalid(id) ||
          !store.dirty(id);
        bar.querySelector("[data-settings-discard]").disabled =
          store.saving || !store.dirty(id);
        bar.querySelector("[role=status]").textContent = store.invalid(id)
          ? "Correct the highlighted fields."
          : "Unsaved changes";
      };
      host.onclick = (e) => {
        const button = e.target.closest("button");
        if (!button) return;
        if (button.dataset.settingsSelect)
          select(button.dataset.settingsSelect);
        if (button.hasAttribute("data-settings-discard")) {
          store.discard(button.closest?.("[data-settings-form]")?.dataset.settingsModule || active);
          render();
          if (!store.dirty()) load();
        }
        if (button.hasAttribute("data-settings-retry")) load();
        if (button.hasAttribute("data-settings-discard-all")) {
          store.drafts.clear();
          store.raws.clear();
          store.validation.clear();
          store.errors.clear();
          load();
        }
        if (button.dataset.policy != null)
          options.openPolicy(
            store.payload.policies[Number(button.dataset.policy)],
          );
      };
      host.onsubmit = async (e) => {
        if (!e.target.matches("[data-settings-form]")) return;
        const id = e.target.dataset?.settingsModule || active;
        if (contextConflict || store.invalid(id)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        const promise = store.save(id, options.post);
        render();
        try {
          await promise;
        } catch (error) {
          if (error.status === 409) await load();
        }
        render();
      };
      if (navigationElement) {
        navigationElement.oninput = host.oninput;
        navigationElement.onclick = host.onclick;
      }
      render();
      load();
    }
    function mountPage(element, options = {}) {
      mount(element, null, options);
    }
    function unmount() {
      if (host) {
        host.oninput = host.onchange = host.onclick = host.onsubmit = null;
        const children = Array.from(host.querySelector("[data-settings-existing]")?.children || []);
        host.innerHTML = "";
        for (const child of children) host.append(child);
      }
      if (navigationHost && navigationHost !== host) {
        navigationHost.oninput = navigationHost.onclick = null;
        navigationHost.innerHTML = "";
      }
      host = navigationHost = null;
    }
    if (typeof window !== "undefined")
      window.addEventListener("beforeunload", (e) => {
        if (store.dirty()) {
          e.preventDefault();
          e.returnValue = "";
        }
      });
    return { mount, mountPage, unmount, select, store, load };
  }
  return { Store, parseField, fieldHTML, navigationModules, create };
});
