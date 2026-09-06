// Host-side HTTP surface for the Web settings card (M4-A): status read +
// manual refresh. Handlers delegate to the SAME tick() the resident timer
// uses, so manual and scheduled refreshes share the single-flight flag and
// the settings.mutate optimistic-lock path — there is exactly one writer.
//
// Route registration mirrors the dsh-better-sidebar /sidebar/api pattern:
// trust fence first, strict method check, JSON envelope, prefix route with a
// returned disposer (cordis 4 has no ctx.dispose — teardown IS the disposer).
import { existsSync, readFileSync } from "node:fs";
import { paths as statePaths } from "../core/state.js";

const BASE = "/model-refresh/api";

// ---------------------------------------------------------------------------
// Trust fence — mirrors dsh-better-sidebar's isTrustedApiRequest: the Host
// must be ours (loopback or a trusted authority) and browser markers must be
// same-origin. Fail-closed: anything unparsable or missing is rejected.
// ---------------------------------------------------------------------------
function header(headers, name) {
  const value = headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`); } catch { return undefined; }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts ?? []).some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/** Decide whether one request may reach the plugin routes. */
export function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === undefined) return true;
  try { return new URL(origin).hostname === hostUrl.hostname; } catch { return false; }
}

// ---------------------------------------------------------------------------
// JSON envelope + handler
// ---------------------------------------------------------------------------
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
const okOut = (res, data) => writeJson(res, 200, { ok: true, ...data });
const failOut = (res, status, code, message) => writeJson(res, status, { ok: false, error: { code, message } });

/** Last persisted plan (state-dir/last-plan.json), or null when absent/corrupt. */
export function readLastPlan(stateDir) {
  try {
    const p = statePaths(stateDir).lastPlan;
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The request dispatcher. Pure over injected controls so tests can drive it
 * without a socket: @param getControls returns { triggerTick, getStatus } or
 * null while the settings seam is absent (plugin dormant); @param fence is the
 * trust gate applied BEFORE any dispatch (403 on refusal).
 */
export function createApiHandler({ getControls, fence = null, log = () => {} } = {}) {
  return async function handler(req, res) {
    if (fence && !fence(req)) return failOut(res, 403, "forbidden", "forbidden");
    const sub = new URL(req.url ?? "/", "http://dsh.internal").pathname;
    const method = req.method;
    if (sub === `${BASE}/status`) {
      if (method !== "GET") return failOut(res, 405, "method-error", "status 需要 GET");
      const controls = getControls();
      if (!controls) return failOut(res, 503, "unavailable", "refresh loop 未啟用（settings seam 缺席）");
      return okOut(res, { status: controls.getStatus() });
    }
    if (sub === `${BASE}/refresh`) {
      if (method !== "POST") return failOut(res, 405, "method-error", "refresh 需要 POST");
      const controls = getControls();
      if (!controls) return failOut(res, 503, "unavailable", "refresh loop 未啟用（settings seam 缺席）");
      const result = await controls.triggerTick({ force: true });
      if (result.busy) return failOut(res, 200, "busy", "上一輪仍在執行，請稍後再試");
      if (result.disabled) return failOut(res, 200, "disabled", "插件已停用（enabled: false）");
      if (!result.ok) return failOut(res, 500, "refresh-failed", result.error ?? "refresh failed");
      return okOut(res, { result });
    }
    if (sub === BASE || sub === `${BASE}/`) {
      return failOut(res, 404, "not-found", "可用方法：GET /status、POST /refresh");
    }
    log(`未知 API 路徑：${method} ${sub}`);
    return failOut(res, 404, "not-found", `unknown api path "${sub}"`);
  };
}

/**
 * Register the plugin routes on the web server. Dormant when no webServer
 * service exists (non-web composition) — the inject callback simply never
 * fires, matching the settings seam's dormant posture. trustedHosts is read
 * lazily at request time: ctx.webRuntime is a plain property that belongs to
 * the webserver plugin, not a service, and may not be visible at mount.
 *
 * @param ctx         the plugin's cordis context
 * @param controlsBox {{ current: {triggerTick, getStatus}|null }} filled by the
 *                    settings inject callback in index.js; read per-request
 * @param log         info logger from the plugin shell
 */
export function registerModelRefreshRoutes(ctx, controlsBox, log = () => {}) {
  ctx.inject(["webServer"], (wctx) => {
    // CRITICAL (M2 lesson): capture the service INSTANCE inside the callback —
    // the injected context itself is invalid after the callback returns.
    const webServer = wctx.webServer;
    const handler = createApiHandler({
      getControls: () => controlsBox.current,
      log,
      // Fail-closed fence: without a trusted-hosts list only loopback passes.
      // ctx.webRuntime is a plain property of the webserver plugin (not a
      // service); read it lazily so mount order never matters.
      fence: (req) => isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts),
    });
    const dispose = webServer.register({
      kind: "prefix",
      path: BASE,
      handler,
    });
    log(`HTTP routes 已註冊：GET ${BASE}/status、POST ${BASE}/refresh`);
    return () => {
      try { dispose?.(); log("HTTP routes 已解除註冊"); } catch { /* best effort */ }
    };
  });
}
