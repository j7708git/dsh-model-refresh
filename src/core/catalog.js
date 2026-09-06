// Fetchers + normalizers: turn the two live catalogs into CatalogEntry pools.
// Both sources answer with an OpenRouter-shaped payload ({data:[...]}); nous also has
// the Portal recommended-models endpoint used only as a free-tier provenance hint.
import { usdPerMillion, fetchJson } from "./support.js";

/**
 * @typedef {object} CatalogEntry
 * @property {string} provider  "openrouter" | "nous"
 * @property {string} id        model id exactly as the provider serves it
 * @property {string} name      display name from the catalog
 * @property {number|null} inPerM   USD per 1M input tokens, in integer millionths
 * @property {number|null} outPerM  USD per 1M output tokens
 * @property {Array<{minTokens:number, inPerM:number|null, outPerM:number|null}>} priceTiers  higher tiers (overrides)
 * @property {number|null} contextWindow
 * @property {number|null} maxTokens
 * @property {string[]} inputModalities   raw (text/image/video/audio/file)
 * @property {boolean} supportsTools
 * @property {boolean} outputsText
 * @property {boolean} free
 * @property {"base"|"free"|"batch"|"router"} variant
 * @property {{intelligence?:number|null, coding?:number|null, agentic?:number|null}} benchmarks
 * @property {string[]} reasoningEfforts
 * @property {string|null} canonicalSlug
 * @property {string|null} huggingFaceId
 * @property {string} description
 * @property {number} created
 * @property {boolean} portalRecommendedFree
 */

function variantOf(id, item) {
  if (id.endsWith(":batch")) return "batch";
  if (id.endsWith(":free") || item?.synthesizedFreeVariant === true) return "free";
  if (id.startsWith("~")) return "router";
  return "base";
}

/** Normalize one raw catalog item; returns null for junk (non-object, no id). */
export function normalizeItem(item, provider, portalFreeIds) {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) return null;
  const pricing = item.pricing ?? {};
  const inPerM = usdPerMillion(pricing.prompt);
  const outPerM = usdPerMillion(pricing.completion);
  const tiers = Array.isArray(pricing.overrides)
    ? pricing.overrides.map((o) => ({
        minTokens: Number(o?.min_prompt_tokens) || 0,
        inPerM: usdPerMillion(o?.prompt),
        outPerM: usdPerMillion(o?.completion),
      }))
    : [];
  const arch = item.architecture ?? {};
  const outMods = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
  const tp = item.top_provider ?? {};
  const aa = item.benchmarks?.artificial_analysis ?? {};
  return {
    provider,
    id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
    inPerM,
    outPerM,
    priceTiers: tiers,
    contextWindow: intOrNull(tp.context_length ?? item.context_length),
    maxTokens: intOrNull(tp.max_completion_tokens ?? item.max_tokens),
    inputModalities: Array.isArray(arch.input_modalities) ? arch.input_modalities : ["text"],
    supportsTools: Array.isArray(item.supported_parameters) ? item.supported_parameters.includes("tools") : false,
    outputsText: outMods.length === 0 || outMods.includes("text"),
    free: inPerM === 0 && outPerM === 0,
    variant: variantOf(id, item),
    benchmarks: {
      intelligence: numberOrNull(aa.intelligence_index),
      coding: numberOrNull(aa.coding_index),
      agentic: numberOrNull(aa.agentic_index),
    },
    reasoningEfforts: Array.isArray(item.reasoning?.supported_efforts) ? item.reasoning.supported_efforts : [],
    canonicalSlug: typeof item.canonical_slug === "string" ? item.canonical_slug : null,
    huggingFaceId: typeof item.hugging_face_id === "string" && item.hugging_face_id ? item.hugging_face_id : null,
    description: typeof item.description === "string" ? item.description : "",
    created: Number(item.created) || 0,
    portalRecommendedFree: provider === "nous" && portalFreeIds.has(id),
  };
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract `{modelName}` sets from a Portal recommendations payload section. */
export function portalModelNames(payload) {
  const out = new Set();
  const lists = [payload?.freeRecommendedModels, payload?.paidRecommendedModels];
  for (const list of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      if (typeof e?.modelName === "string" && e.modelName.trim()) out.add(e.modelName.trim());
    }
  }
  for (const key of ["freeRecommendedVisionModel", "freeRecommendedCompactionModel"]) {
    const m = payload?.[key]?.modelName;
    if (typeof m === "string" && m.trim()) out.add(m.trim());
  }
  return out;
}

/**
 * Fetch both catalogs. Per-source failures are collected in `errors` and that
 * source falls back to `lastGood` (caller-provided) if given — refresh never
 * proceeds on a partially missing pool unless there is truly no data at all.
 *
 * @param cfg         loaded config
 * @param lastGood    {openrouter?: CatalogEntry[], nous?: CatalogEntry[]} | undefined
 * @param fetcherImpl injection seam for tests (defaults to support.fetchJson)
 * @returns {Promise<{pools: Record<string, CatalogEntry[]>, errors: string[], fetchedAt: string}>}
 */
export async function fetchAll(cfg, { lastGood, fetcherImpl = fetchJson } = {}) {
  const errors = [];
  const pools = {};
  const opts = { timeoutMs: cfg.fetch.timeoutMs, attempts: cfg.fetch.attempts, backoffMs: cfg.fetch.backoffMs };

  // -- OpenRouter ----------------------------------------------------------------
  try {
    const payload = await fetcherImpl(cfg.sources.openrouter.url, opts);
    pools.openrouter = (payload?.data ?? []).map((i) => normalizeItem(i, "openrouter", new Set())).filter(Boolean);
    if (pools.openrouter.length === 0) throw new Error("empty data[]");
  } catch (err) {
    errors.push(`openrouter: ${err.message}`);
    if (lastGood?.openrouter?.length) pools.openrouter = lastGood.openrouter;
  }

  // -- Nous (catalog + recommended hints) -----------------------------------------
  try {
    const [catalog, recommended] = await Promise.all([
      fetcherImpl(cfg.sources.nous.catalogUrl, opts),
      fetcherImpl(cfg.sources.nous.recommendedUrl, opts).catch(() => null),
    ]);
    const portalFree = new Set(
      (recommended?.freeRecommendedModels ?? [])
        .map((e) => (typeof e?.modelName === "string" ? e.modelName.trim() : null))
        .filter(Boolean),
    );
    pools.nous = (catalog?.data ?? []).map((i) => normalizeItem(i, "nous", portalFree)).filter(Boolean);
    if (pools.nous.length === 0) throw new Error("empty data[]");
  } catch (err) {
    errors.push(`nous: ${err.message}`);
    if (lastGood?.nous?.length) pools.nous = lastGood.nous;
  }

  return { pools, errors, fetchedAt: new Date().toISOString() };
}
