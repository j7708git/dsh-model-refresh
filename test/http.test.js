import test from "node:test";
import assert from "node:assert/strict";

import { createApiHandler, isTrustedApiRequest, readLastPlan } from "../src/plugin/http.js";

// -- fake request/response ----------------------------------------------------
function req(method, url, headers = {}) {
  return { method, url, headers };
}
function res() {
  const r = { statusCode: undefined, headers: null, body: undefined };
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers; };
  r.end = (body) => { r.body = body; };
  return r;
}
async function call(handler, r, response = res()) {
  await handler(r, response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

// -- controls stubs ------------------------------------------------------------
function okControls(over = {}) {
  return {
    current: {
      async triggerTick(opts = {}) { return { ok: true, applied: true, writes: 1, added: 2, removed: 0, warnings: [], forced: Boolean(opts.force) }; },
      getStatus() { return { prefs: { enabled: true, intervalHours: 12, initialDelaySeconds: 90 }, lastRunAt: "T", lastAppliedAt: null, routes: { openrouter: 22 } }; },
      ...over,
    },
  };
}
const noControls = { current: null };

test("trust fence: loopback host passes, missing/cross-site/foreign-host fail closed", () => {
  const none = [];
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "127.0.0.1:3080" }), none), true);
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "localhost:3080" }), none), true);
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "[::1]:3080" }), none), true);
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "127.0.0.2:3080" }), none), true, "127/8 loopback");
  assert.equal(isTrustedApiRequest(req("GET", "/", {}), none), false, "missing host");
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "not a host!!" }), none), false, "unparsable host");
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "evil.example.com" }), none), false, "non-loopback without trust list");
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "10.1.2.3" }), ["10.1.2.3"]), true, "trusted authority");
  assert.equal(isTrustedApiRequest(req("GET", "/", { host: "10.1.2.4" }), ["10.1.2.3"]), false, "authority not on the list");
  assert.equal(
    isTrustedApiRequest(req("GET", "/", { host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" }), none),
    false,
    "cross-site browser marker",
  );
  assert.equal(
    isTrustedApiRequest(req("GET", "/", { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), none),
    true,
    "same-origin marker",
  );
  assert.equal(
    isTrustedApiRequest(req("GET", "/", { host: "127.0.0.1:3080", origin: "http://evil.example.com" }), none),
    false,
    "origin/host mismatch",
  );
});

test("GET status returns the controls snapshot", async () => {
  const handler = createApiHandler({ getControls: () => okControls().current });
  const { status, body } = await call(handler, req("GET", "/model-refresh/api/status", { host: "127.0.0.1" }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status.prefs.intervalHours, 12);
  assert.equal(body.status.routes.openrouter, 22);
});

test("POST refresh forces a tick and returns its result; timer semantics untouched", async () => {
  const box = okControls();
  const handler = createApiHandler({ getControls: () => box.current });
  const { status, body } = await call(handler, req("POST", "/model-refresh/api/refresh", { host: "127.0.0.1" }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.applied, true);
  assert.equal(body.result.forced, true, "manual refresh bypasses the enabled gate");
});

test("busy single-flight is reported, not swallowed", async () => {
  const box = okControls({ async triggerTick() { return { ok: false, busy: true }; } });
  const handler = createApiHandler({ getControls: () => box.current });
  const { status, body } = await call(handler, req("POST", "/model-refresh/api/refresh", { host: "127.0.0.1" }));
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "busy");
});

test("dormant plugin (no controls) answers 503 unavailable on both methods", async () => {
  const handler = createApiHandler({ getControls: () => noControls.current });
  const a = await call(handler, req("GET", "/model-refresh/api/status", { host: "127.0.0.1" }));
  const b = await call(handler, req("POST", "/model-refresh/api/refresh", { host: "127.0.0.1" }));
  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
  assert.equal(a.body.error.code, "unavailable");
});

test("tick failure maps to refresh-failed, not a crash", async () => {
  const box = okControls({ async triggerTick() { return { ok: false, error: "boom" }; } });
  const handler = createApiHandler({ getControls: () => box.current });
  const { status, body } = await call(handler, req("POST", "/model-refresh/api/refresh", { host: "127.0.0.1" }));
  assert.equal(status, 500);
  assert.equal(body.error.code, "refresh-failed");
  assert.equal(body.error.message, "boom");
});

test("method and path discipline", async () => {
  const handler = createApiHandler({ getControls: () => okControls().current });
  const wrongMethodStatus = await call(handler, req("POST", "/model-refresh/api/status", { host: "127.0.0.1" }));
  const wrongMethodRefresh = await call(handler, req("GET", "/model-refresh/api/refresh", { host: "127.0.0.1" }));
  const unknown = await call(handler, req("GET", "/model-refresh/api/other", { host: "127.0.0.1" }));
  const root = await call(handler, req("GET", "/model-refresh/api/", { host: "127.0.0.1" }));
  assert.equal(wrongMethodStatus.status, 405);
  assert.equal(wrongMethodRefresh.status, 405);
  assert.equal(unknown.status, 404);
  assert.equal(root.status, 404);
});

test("fence rejects before any dispatch", async () => {
  const handler = createApiHandler({
    getControls: () => okControls().current,
    fence: (r) => isTrustedApiRequest(r, []),
  });
  const { status, body } = await call(handler, req("GET", "/model-refresh/api/status", { host: "evil.example.com" }));
  assert.equal(status, 403);
  assert.equal(body.error.code, "forbidden");
  const good = await call(handler, req("GET", "/model-refresh/api/status", { host: "127.0.0.1" }));
  assert.equal(good.status, 200);
});

test("readLastPlan: absent dir → null; corrupt json → null; valid → parsed", async () => {
  assert.equal(readLastPlan("Z:/definitely/not/here"), null);
  // corrupt fixture: point statePaths at a temp dir with a broken last-plan.json
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mr-http-"));
  mkdirSync(join(dir, "backups"), { recursive: true });
  writeFileSync(join(dir, "last-plan.json"), "{not json");
  assert.equal(readLastPlan(dir), null);
  writeFileSync(join(dir, "last-plan.json"), JSON.stringify({ generatedAt: "G", routes: { "nous-api": { entries: [1, 2] } } }));
  const plan = readLastPlan(dir);
  assert.equal(plan.generatedAt, "G");
  assert.equal(plan.routes["nous-api"].entries.length, 2);
});
