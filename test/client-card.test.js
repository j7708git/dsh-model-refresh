import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The client bundle is a browser artifact in the lazy-CJS factory wire format.
// Smoke-test it offline: execute the bundle body in a VM with a capturing
// __ModuleLoader__, then materialize the factory with stub require()/ctx and
// assert the slot registration contract (M4 規劃 §2.2).

const HERE = dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(join(HERE, "..", "src", "client.js"), "utf8");

function loadBundle() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (row) => { captured = row; } } },
    // intentionally NO document: injectCss must no-op outside a browser
    fetch: async () => { throw new Error("no network in unit test"); },
    console,
  };
  vm.runInNewContext(bundleSource, sandbox, { filename: "src/client.js" });
  assert.ok(captured, "bundle registered itself with window.__ModuleLoader__.load");
  return captured;
}

/** Stub React: createElement records the tree; hooks mimic React's contract
 * (the useState initializer IS executed, so the component reads its real
 * first-paint state without a renderer). */
function stubReact() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement: h,
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
  };
}

function makeCtx() {
  const bound = [];
  const registrations = [];
  const injections = [];
  const scope = {
    namespace: null,
    getSnapshot: () => ({
      status: "ready",
      value: { enabled: true, intervalHours: 12, initialDelaySeconds: 90 },
      base: undefined,
      user: { intervalHours: 6 },
      revision: 3,
      writable: true,
      mode: "host",
    }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
    mutate: async (ops) => {
      scope.lastMutate = ops;
      return undefined;
    },
  };
  return {
    bound,
    registrations,
    injections,
    scope,
    settingsScope: {
      bind(spec) { bound.push(spec.namespace); scope.namespace = spec.namespace; return scope; },
    },
    slots: {
      inject(name, gen) {
        injections.push(name);
        for (const reg of gen()) registrations.push(reg);
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
}

test("client bundle uses the lazy-CJS factory envelope with the package id", () => {
  const row = loadBundle();
  assert.equal(row.id, "dsh-model-refresh");
  assert.equal(typeof row.factory, "function");
  assert.match(bundleSource, /exports\.apply\s*=/, "factory exports apply() like every client plugin");
});

test("card registers into settings.plugin.item keyed by its settings namespace", () => {
  const row = loadBundle();
  const ctx = makeCtx();
  const exports = row.factory((name) => {
    if (name === "react") return stubReact();
    throw new Error("unexpected require: " + name);
  });
  assert.equal(typeof exports.apply, "function");
  exports.apply(ctx);

  assert.deepEqual(ctx.bound, ["dsh-model-refresh"], "binds exactly its own namespace");
  assert.ok(ctx.injections.includes("settings.plugin.item"), "fills the keyed card slot");
  const card = ctx.registrations.find((r) => r.options.name === "settings.plugin.item");
  assert.ok(card, "card registered");
  assert.equal(card.options.key, "dsh-model-refresh", "slot key === settings namespace (the intersection rule)");
  assert.equal(typeof card.component, "function", "a React component is attached");
  const injected = card.options.inject();
  assert.ok(injected.ctrl && typeof injected.ctrl.save === "function" && typeof injected.ctrl.refresh === "function", "inject hands the controller to the card");
});

test("controller save() stages→mutates only changed fields with revision-fenced ops", async () => {
  const row = loadBundle();
  const ctx = makeCtx();
  const exports = row.factory((name) => (name === "react" ? stubReact() : undefined));
  exports.apply(ctx);
  const scope = ctx.scope;
  const ctrl = ctx.registrations.find((r) => r.options.name === "settings.plugin.item").options.inject().ctrl;

  // intervalHours is overridden (user layer) with 6; staged change to 8 → one set op
  // (cross-realm objects: compare by JSON, not by prototype)
  const result = await ctrl.save({ intervalHours: 8 }, scope.getSnapshot().value);
  assert.equal(result.saved, 1);
  assert.equal(JSON.stringify(scope.lastMutate), JSON.stringify([{ op: "set", path: ["intervalHours"], value: 8 }]));

  // no-op save (nothing staged) → no wire write
  const result2 = await ctrl.save({}, scope.getSnapshot().value);
  assert.equal(result2.saved, 0);

  // invalid number draft blocks the save instead of being dropped
  const bad = await ctrl.save({ intervalHours: "abc" }, scope.getSnapshot().value);
  assert.ok(bad.error, "invalid draft blocks save");
  assert.equal(scope.lastMutate.length, 1, "no new ops were written");

  // enabled boolean round-trips
  const ok3 = await ctrl.save({ enabled: false }, scope.getSnapshot().value);
  assert.equal(ok3.saved, 1);
  assert.equal(JSON.stringify(scope.lastMutate), JSON.stringify([{ op: "set", path: ["enabled"], value: false }]));
});

test("card renders absent-state when scope is not ready, form when ready", () => {
  const row = loadBundle();
  const ctx = makeCtx();
  const exports = row.factory((name) => (name === "react" ? stubReact() : undefined));
  exports.apply(ctx);
  const card = ctx.registrations.find((r) => r.options.name === "settings.plugin.item");
  const ctrl = card.options.inject().ctrl;

  // unavailable: the whole form must be absent (no half-decoded rows)
  const realGetSnapshot = ctx.scope.getSnapshot;
  ctx.scope.getSnapshot = () => ({ status: "unavailable", value: undefined, user: undefined, mode: "memory" });
  const absentTree = JSON.stringify(card.component({ ctrl }));
  assert.ok(absentTree.includes("此連線不支援持久設定"), "absent-state message rendered");
  assert.ok(!absentTree.includes("立即刷新一次"), "no action buttons while unavailable");

  // ready: the form with its controls and the manual-refresh entry point
  ctx.scope.getSnapshot = realGetSnapshot;
  const readyTree = JSON.stringify(card.component({ ctrl }));
  assert.ok(readyTree.includes("立即刷新一次"), "manual refresh button present");
  assert.ok(readyTree.includes("刷新間隔"), "prefs fields present");
  assert.ok(readyTree.includes("已覆寫"), "override badge rendered from the user layer");
});

test("package.json declares dsh.client (web) + exports ./client", async () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.equal(pkg.exports["./client"], "./src/client.js");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"), "injects the settings base (ctx.settingsScope provider)");
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots"), "injects the slots base (ctx.slots provider)");
  assert.equal(pkg.main, pkg.exports["."], "root entry intact (M2 lesson: bare-name import must keep working)");
});
