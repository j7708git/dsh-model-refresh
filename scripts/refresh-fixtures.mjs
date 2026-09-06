// Fetch live catalogs into test/fixtures/ for offline unit tests.
// Usage: npm run fixtures   (needs network)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson } from "../src/core/support.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
mkdirSync(out, { recursive: true });

const targets = {
  "openrouter.json": "https://openrouter.ai/api/v1/models",
  "nous.json": "https://inference-api.nousresearch.com/v1/models",
  "nous-recommended.json": "https://portal.nousresearch.com/api/nous/recommended-models",
};

for (const [name, url] of Object.entries(targets)) {
  const json = await fetchJson(url, { timeoutMs: 30_000 });
  writeFileSync(join(out, name), JSON.stringify(json));
  console.log(`${name}: saved`);
}
console.log("fixtures 已更新（含抓取當時的即時價格與免費池）");
