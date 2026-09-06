// Scratch: reproduce the real cordis host mount of dsh-model-refresh in-process.
// Mirrors @deepseek-ai/cordis/bin.js (Context + plugin-loader), baseUrl = web profile dir.
import { Context, Service } from "file:///C:/Users/denny/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const stateDir = mkdtempSync(join(tmpdir(), "mr-real-"));
process.env.DSH_MODEL_REFRESH_STATE_DIR = stateDir;

class FakeSettings extends Service {
  constructor(ctx) {
    super(ctx, "settings");
    this.providers = {
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", models: [{ id: "deepseek/deepseek-v4-flash", name: "keepme" }] },
      "nous-api": { apiKeyEnv: "NOUS_API_KEY", api: "openai-completions", baseURL: "https://inference-api.nousresearch.com/v1", models: [{ id: "qwen/qwen3.8-flash", name: "Q" }] },
    };
    this.revision = 1;
    this.registered = [];
    this.mutateCalls = 0;
  }
  get(ns) {
    if (ns === "llm-pi-ai") return { providers: this.providers };
    if (ns === "agent-default-model") return { provider: "nous-api", model: "qwen/qwen3.8-flash" };
    return undefined;
  }
  describe() { return [{ ns: "llm-pi-ai", revision: this.revision }]; }
  register(ns) {
    this.registered.push(ns);
    return {
      get: () => ({ enabled: true, intervalHours: 12, initialDelaySeconds: 0 }),
      watch: () => () => {},
    };
  }
  async mutate(ns, ops, rev) {
    if (rev !== this.revision) { const e = new Error("stale"); e.code = "SETTINGS_CONFLICT"; throw e; }
    for (const op of ops) {
      const [, route, field] = op.path;
      this.providers[route][field] = structuredClone(op.value);
    }
    this.revision++;
    this.mutateCalls++;
    console.log(`[fake-settings] mutate #${this.mutateCalls}: ${ops.map((o) => o.path.join(".")).join(", ")}`);
  }
}

const Loader = (await import("file:///C:/Users/denny/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js")).default;

const ctx = new Context();
ctx.baseUrl = pathToFileURL("C:\\Users\\denny\\.dsh\\profiles\\web").href + "/";
if (ctx.logger) ctx.logger.level = "debug";

// time every network call the tick makes
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const t0 = Date.now();
  try {
    const r = await realFetch(url, opts);
    console.log(`[fetch] ${String(url).slice(0, 70)} → ${r.status} in ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    console.log(`[fetch] ${String(url).slice(0, 70)} → ERROR ${e.name} ${e.message} after ${Date.now() - t0}ms`);
    throw e;
  }
};

// instrumentation: shadow ctx.inject to see who asks for optional services and when callbacks fire
const origInject = ctx.inject.bind(ctx);
ctx.inject = (deps, cb) => {
  console.log("[probe] ctx.inject", JSON.stringify(deps));
  return origInject(deps, (c) => { console.log("[probe] inject callback FIRED for", JSON.stringify(deps)); return cb(c); });
};
const origRegister = FakeSettings.prototype.register;
FakeSettings.prototype.register = function (ns, schema) {
  console.log("[probe] settings.register(", ns, ")");
  const scope = origRegister.call(this, ns, schema);
  const origGet = scope.get;
  scope.get = () => { const v = origGet(); console.log("[probe] scope.get ->", JSON.stringify(v)); return v; };
  return scope;
};

new FakeSettings(ctx);
await ctx.plugin(Loader);
console.log("mounting dsh-model-refresh by bare name via real loader...");
await ctx.loader.create({ name: "dsh-model-refresh" });
console.log("mounted ✓");

const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  if (existsSync(join(stateDir, "CHANGES.md"))) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const fs = await import("node:fs");
if (fs.existsSync(join(stateDir, "state.json"))) {
  const s = JSON.parse(fs.readFileSync(join(stateDir, "state.json"), "utf8"));
  console.log("TICK RAN ✓ lastRunAt:", s.lastRunAt);
} else {
  console.log("NO TICK OUTPUT within 90s ✗ — state dir contents:", fs.readdirSync(stateDir));
}
process.exit(0);
