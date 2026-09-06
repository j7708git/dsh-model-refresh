import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// packaging guard — the cordis loader imports bundles by BARE package name, so
// "." must be an exported entry (the bug that broke `dsh web` boot on 2026-09-06).
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
test("package.json exposes a root entry for bare-name imports", () => {
  assert.ok(pkg.exports["."], "exports['.'] required for cordis bundle mounting");
  assert.equal(pkg.main, pkg.exports["."]);
});

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const orJson = JSON.parse(readFileSync(join(FIX, "openrouter.json"), "utf8"));
const nousJson = JSON.parse(readFileSync(join(FIX, "nous.json"), "utf8"));
const recJson = JSON.parse(readFileSync(join(FIX, "nous-recommended.json"), "utf8"));
function fakeFetcher(url) {
  if (url.includes("openrouter.ai")) return Promise.resolve(orJson);
  if (url.includes("inference-api")) return Promise.resolve(nousJson);
  if (url.includes("recommended-models")) return Promise.resolve(recJson);
  throw new Error(`unexpected ${url}`);
}

// redirect the plugin's state off the real ~/.dsh BEFORE apply() builds cfg
process.env.DSH_MODEL_REFRESH_STATE_DIR = mkdtempSync(join(tmpdir(), "mr-mount-"));

const { apply, name, PREFS_NS } = await import("../src/plugin/index.js");

function makeSettings() {
  const providers = {
    openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", models: [] },
    "nous-api": {
      apiKeyEnv: "NOUS_API_KEY", api: "openai-completions",
      baseURL: "https://inference-api.nousresearch.com/v1",
      models: [{ id: "qwen/qwen3.8-flash", name: "Qwen: Qwen3.8 Flash" }],
    },
  };
  let revision = 1;
  const registered = [];
  return {
    providers,
    registered,
    get revision() { return revision; },
    register(ns) {
      registered.push(ns);
      return {
        get: () => ({ enabled: true, intervalHours: 12, initialDelaySeconds: 0 }),
        watch: () => () => {},
      };
    },
    get(ns) {
      if (ns === "llm-pi-ai") return { providers };
      if (ns === "agent-default-model") return { provider: "nous-api", model: "qwen/qwen3.8-flash" };
      return undefined;
    },
    describe() { return [{ ns: "llm-pi-ai", revision }]; },
    async mutate(ns, ops, rev) {
      if (rev !== revision) { const e = new Error("stale"); e.code = "SETTINGS_CONFLICT"; throw e; }
      for (const op of ops) {
        const [, route, field] = op.path;
        providers[route][field] = structuredClone(op.value);
      }
      revision++;
    },
  };
}

function makeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
    },
  };
}

function makeCtx(settingsService, webServerService = null) {
  const logs = { info: [], warn: [], error: [] };
  const disposers = [];
  return {
    logs,
    disposers,
    webRuntime: { trustedHosts: [] },
    // Mirror the REAL cordis 4 surface: Context has NO `dispose` method — the
    // effect disposer is what a plugin callback RETURNS. An earlier fake
    // invented ctx.dispose and let a real TypeError slip to production.
    inject(deps, cb) {
      if (deps.includes("settings")) disposers.push(cb({ settings: settingsService }));
      else if (deps.includes("webServer") && webServerService) disposers.push(cb({ webServer: webServerService }));
    },
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
  };
}

async function waitUntil(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("plugin mount end-to-end with fake cordis ctx (offline catalogs)", async () => {
  const dir1 = mkdtempSync(join(tmpdir(), "mr-mount1-"));
  process.env.DSH_MODEL_REFRESH_STATE_DIR = dir1;
  assert.equal(name, "dsh-model-refresh");
  const settings = makeSettings();
  const ctx = makeCtx(settings);

  apply(ctx, { fetcherImpl: fakeFetcher });

  assert.deepEqual(settings.registered, [PREFS_NS], "registers its prefs namespace via the settings seam");
  await waitUntil(async () => settings.providers.openrouter.models.length >= 5, 15_000, "first tick to apply");

  const orIds = settings.providers.openrouter.models.map((m) => m.id);
  for (const pin of ["~deepseek/deepseek-v4-flash-latest", "z-ai/glm-5.3-flash", "qwen/qwen3.8-flash"]) {
    assert.ok(orIds.includes(pin), `pin ${pin} present after mount tick`);
  }
  assert.equal(settings.providers["nous-api"].baseURL, "https://inference-api.nousresearch.com/v1", "route fields outside models untouched");
  assert.ok(ctx.logs.info.some((l) => l.includes("已套用")), "logged an apply line");
  assert.ok(ctx.logs.info.some((l) => l.includes("已載入")), "mount tail executed (no early throw in the inject callback)");
  assert.deepEqual(ctx.logs.error, [], "no errors during mount/tick");
  await waitUntil(async () => existsSync(join(dir1, "CHANGES.md")) && existsSync(join(dir1, "state.json")), 5_000, "state files");

  // second scheduled cadence would take hours; verify dispose clears timers cleanly
  for (const d of ctx.disposers) d();
});

test("plugin tick is conflict-tolerant and crash-safe", async () => {
  process.env.DSH_MODEL_REFRESH_STATE_DIR = mkdtempSync(join(tmpdir(), "mr-mount2-"));
  const settings = makeSettings();
  const originalMutate = settings.mutate.bind(settings);
  let first = true;
  settings.mutate = async (ns, ops, rev) => {
    if (first) { first = false; const e = new Error("namespace moved"); e.code = "SETTINGS_CONFLICT"; throw e; }
    return originalMutate(ns, ops, rev);
  };
  const ctx = makeCtx(settings);
  apply(ctx, { fetcherImpl: fakeFetcher });
  await waitUntil(async () => settings.providers.openrouter.models.length >= 5, 15_000, "apply after conflict retry");
  assert.deepEqual(ctx.logs.error, []);
  for (const d of ctx.disposers) d();
});

test("M4-A: webServer routes registered, manual refresh runs the same tick, dispose removes routes", async () => {
  process.env.DSH_MODEL_REFRESH_STATE_DIR = mkdtempSync(join(tmpdir(), "mr-mount3-"));
  const settings = makeSettings();
  const webServer = makeWebServer();
  const ctx = makeCtx(settings, webServer);

  apply(ctx, { fetcherImpl: fakeFetcher });

  const route = webServer.routes.find((r) => r.path === "/model-refresh/api");
  assert.ok(route, "prefix route registered on the webServer seam");
  assert.equal(route.kind, "prefix");
  assert.ok(ctx.logs.info.some((l) => l.includes("HTTP routes 已註冊")), "registration logged");

  // drive the handler directly (no socket): manual refresh shares the loop tick
  const handler = route.handler;
  const post = async () => {
    const res = { statusCode: undefined, headers: null, body: undefined, writeHead(c, h) { this.statusCode = c; this.headers = h; }, end(b) { this.body = b; } };
    await handler({ method: "POST", url: "/model-refresh/api/refresh", headers: { host: "127.0.0.1:3080" } }, res);
    return JSON.parse(res.body);
  };
  const body = await post();
  assert.equal(body.ok, true, `manual refresh ok (got ${JSON.stringify(body)})`);
  assert.equal(body.result.applied, true, "manual refresh applied through settings.mutate");
  await waitUntil(async () => existsSync(join(process.env.DSH_MODEL_REFRESH_STATE_DIR, "state.json")), 5_000, "manual-refresh state");

  // GET status returns prefs + persisted facts
  const res2 = { statusCode: undefined, body: undefined, writeHead() {}, end(b) { this.body = b; } };
  await handler({ method: "GET", url: "/model-refresh/api/status", headers: { host: "localhost" } }, res2);
  const statusBody = JSON.parse(res2.body);
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.status.prefs.enabled, true);
  assert.ok(statusBody.status.lastRunAt, "lastRunAt surfaced from state.json");

  // untrusted host is fenced
  const res3 = { statusCode: undefined, body: undefined, writeHead() {}, end(b) { this.body = b; } };
  await handler({ method: "GET", url: "/model-refresh/api/status", headers: { host: "evil.example.com" } }, res3);
  assert.equal(JSON.parse(res3.body).error.code, "forbidden");

  // dispose removes the route (cordis 4 teardown = returned disposer)
  for (const d of ctx.disposers) d();
  assert.equal(webServer.routes.length, 0, "routes disposed with the plugin");
});
