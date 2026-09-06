// Planner: merges R1/R2/R3 outputs with imported (user-original) entries into
// the final per-route model lists + a human-readable diff report. Pure — the
// caller supplies the current settings snapshot and persisted state, so planner
// tests need no network and no files.
import { PROVIDERS } from "./config.js";
import { resolvePins, selectFree, selectCandidates, makeScorer } from "./rules.js";

/**
 * @param {object} input
 * @param cfg                                    loaded config
 * @param pools {openrouter: CatalogEntry[], nous: CatalogEntry[]}
 * @param current {openrouter?: {models: object[], exists: boolean}, 'nous-api'?: ...}  read from settings.yaml
 * @param state {object|null}                   persisted state (null on first run)
 * @param agentDefault {provider:string, model:string}|null
 * @param nowMs number
 */
export function buildPlan({ cfg, pools, current, state, agentDefault, nowMs }) {
  const firstRun = !state?.managedIds;
  const report = { added: [], removed: [], kept: [], warnings: [], notes: [], candidateScores: {} };
  const plan = { generatedAt: new Date(nowMs).toISOString(), routes: {} };
  const statePatch = {
    lastRunAt: new Date(nowMs).toISOString(),
    managedIds: {},
    importedEntries: {},
    candidateLedgers: { ...(state?.candidateLedgers ?? {}) },
    pinSnapshot: { ...(state?.pinSnapshot ?? {}) },
    suppressedIds: { ...(state?.suppressedIds ?? {}) },
  };

  for (const [provider, meta] of Object.entries(PROVIDERS)) {
    const routeKey = meta.route;
    const pool = pools[provider];
    if (!pool?.length) {
      report.warnings.push(`${provider}: 目錄抓取失敗且無可用快取 — 本輪保留現狀，不寫入`);
      // carry the previous per-provider state forward, or the wholesale state
      // overwrite would freeze the stale lists into "imported" next run
      statePatch.managedIds[provider] = state?.managedIds?.[provider];
      statePatch.importedEntries[provider] = state?.importedEntries?.[provider] ?? [];
      statePatch.suppressedIds[provider] = state?.suppressedIds?.[provider] ?? [];
      continue;
    }
    const routeCurrent = current[routeKey] ?? { models: [], exists: false };
    const curIds0 = new Set(routeCurrent.models.map((m) => m.id));

    // ---- R2 pins -------------------------------------------------------------
    const { resolved, missing } = resolvePins(cfg, pool, provider);
    const byId = new Map(routeCurrent.models.map((m) => [m.id, m]));
    const pinRows = [];
    const pinIds = new Set();
    const snapshotByKey = {};
    for (const { pinKey, entry } of resolved) {
      const existing = byId.get(entry.id);
      let row;
      if (existing && firstRun) {
        // takeover: keep the user's fields on a same-id pin, fill missing metadata from catalog
        const gen = entryToYaml(entry, "pin");
        row = {
          id: gen.id,
          name: existing.name ?? gen.name,
          contextWindow: existing.contextWindow ?? gen.contextWindow,
          maxTokens: existing.maxTokens ?? gen.maxTokens,
          input: existing.input ?? gen.input,
          reasoningEfforts: existing.reasoningEfforts ?? gen.reasoningEfforts,
          _rule: "pin",
        };
      } else {
        row = { ...entryToYaml(entry, "pin"), _rule: "pin" };
      }
      pinRows.push(row);
      pinIds.add(row.id);
      snapshotByKey[pinKey] = strip(row);
    }
    for (const pinKey of missing) {
      const snap = state?.pinSnapshot?.[provider]?.[pinKey];
      if (snap) {
        pinRows.push({ ...snap, _rule: "pin-stale" });
        pinIds.add(snap.id);
        snapshotByKey[pinKey] = snap; // carry the snapshot forward while unreachable
        report.warnings.push(`${provider}: pin「${pinKey}」不在線上目錄 — 保留上次條目 ${snap.id}`);
      } else {
        report.warnings.push(`${provider}: pin「${pinKey}」無法解析（目錄查無此 id），本輪未加入`);
      }
    }
    statePatch.pinSnapshot[provider] = snapshotByKey;

    // ---- imported: settings.yaml is the source of truth (user edits survive) ----
    // Adoption:   entries unknown to the tool (or previously imported) carry over
    //             verbatim from the current file — manual edits to them are kept.
    // Deletion:   a managed entry missing from settings was removed by hand →
    //             suppressed from now on (never silently re-added). Pins are the
    //             exception: they are restored with a warning, per §7.2.
    const managedList = firstRun ? [] : (state.managedIds?.[provider] ?? []);
    const managedKnown = new Set(managedList.map((m) => m.id));
    const ruleById = new Map(managedList.map((m) => [m.id, m.rule]));
    const suppressed = new Set(state?.suppressedIds?.[provider] ?? []);
    if (!firstRun) {
      for (const id of managedKnown) {
        if (curIds0.has(id)) continue;
        if (pinIds.has(id)) { report.warnings.push(`${provider}: pin ${id} 被手動移除 — 依常駐規則自動恢復`); continue; }
        if (!suppressed.has(id)) {
          suppressed.add(id); // any hand-removal of a tool-owned entry (free/candidate/imported) is intent
          report.notes.push(`${provider}: 偵測手動刪除 ${id} — 加入抑制清單，不再自動加回`);
        }
      }
    }
    const imported = [];
    let adoptedCount = 0;
    for (const m of routeCurrent.models) {
      if (pinIds.has(m.id) || suppressed.has(m.id)) continue;
      const known = ruleById.get(m.id);
      if (firstRun || known === "imported" || known === undefined) {
        imported.push({ ...m, _rule: "imported" });
        if (!firstRun && known === undefined) adoptedCount++;
      }
      // known ∈ {candidate, free, pin-stale}: regenerated by rules — not imported
    }
    if (adoptedCount) report.notes.push(`${provider}: 接手 ${adoptedCount} 條新出現的手動條目（imported）`);
    const importedIds = new Set(imported.map((m) => m.id));
    statePatch.suppressedIds = { ...(statePatch.suppressedIds ?? {}), [provider]: [...suppressed] };

    // ---- R3 candidates --------------------------------------------------------
    const scorer = makeScorer(cfg, pool, resolved);
    const takenForCand = new Set([...pinIds, ...importedIds]);
    const cand = selectCandidates(cfg, pool, scorer, takenForCand, {
      nowMs,
      ledger: state?.candidateLedgers?.[provider],
      provider,
      excludePinIds: pinIds,
      suppressed,
    });
    for (const n of cand.notes) report.notes.push(`${provider}: ${n}`);
    const candidateRows = cand.entries.map((r) => ({ ...entryToYaml(r.entry, "candidate"), _rule: "candidate" }));
    const candidateIds = new Set(candidateRows.map((r) => r.id));
    statePatch.candidateLedgers[provider] = cand.ledger;
    for (const r of cand.entries) {
      report.candidateScores[`${provider}/${r.entry.id}`] = { score: r.score, unverified: r.unverified, basis: r.basis };
    }

    // ---- R1 free pool ---------------------------------------------------------
    const takenForFree = new Set([...pinIds, ...candidateIds, ...importedIds]);
    const free = selectFree(cfg, pool, scorer, takenForFree, suppressed);
    const freeRows = free.map((f) => ({ ...entryToYaml(f.entry, "free", "[Free] "), _rule: "free" }));
    const freeIds = new Set(freeRows.map((r) => r.id));

    // ---- assemble (order: pins → candidates → imported → free) ----------------
    let rows = [...pinRows, ...candidateRows, ...imported, ...freeRows];

    // route cap: shed free entries first, then complain loudly
    if (rows.length > cfg.routeCap) {
      let overflow = rows.length - cfg.routeCap;
      rows = rows.filter((r) => {
        if (overflow > 0 && r._rule === "free") { overflow--; report.notes.push(`${provider}: 超過 route 上限，移除 ${r.id}`); return false; }
        return true;
      });
      if (overflow > 0) report.warnings.push(`${provider}: 移除全部 free 後仍超出上限 ${overflow} 條 — 請調高 routeCap 或精簡 imported`);
    }

    // ---- agent-default protection ---------------------------------------------
    if (cfg.protectAgentDefault && agentDefault && agentDefault.provider === routeKey) {
      const id = agentDefault.model;
      if (!rows.some((r) => r.id === id) && byId.has(id)) {
        rows.push({ ...byId.get(id), _rule: "imported" });
        importedIds.add(id);
        report.warnings.push(`${provider}: ${id} 為當前 agent-default-model，雖被規則排除仍強制保留`);
      }
    }

    // ---- diff + first-run additions-only guard ----------------------------------
    const curIds = new Set(routeCurrent.models.map((m) => m.id));
    let newIds = new Set(rows.map((r) => r.id));
    if (firstRun) {
      for (const id of curIds) {
        if (!newIds.has(id)) {
          rows.push({ ...byId.get(id), _rule: "imported" });
          report.warnings.push(`${provider}: 首次接管 — 原條目 ${id} 未命中任何規則，以 imported 保留`);
        }
      }
      newIds = new Set(rows.map((r) => r.id));
    }
    for (const r of rows) if (!curIds.has(r.id)) report.added.push({ provider, id: r.id, rule: r._rule });
    for (const id of curIds) {
      if (!newIds.has(id)) report.removed.push({ provider, id });
      else report.kept.push({ provider, id });
    }

    plan.routes[routeKey] = {
      provider,
      exists: routeCurrent.exists,
      entries: rows.map(strip),
      rules: rows.map((r) => r._rule),
    };
    statePatch.managedIds[provider] = rows.map((r) => ({ id: r.id, rule: r._rule }));
    statePatch.importedEntries[provider] = rows.filter((r) => r._rule === "imported").map(strip);
  }

  return { plan, report, statePatch };
}

/** Convert a CatalogEntry into the settings.yaml model entry object. */
export function entryToYaml(entry, rule, namePrefix = "") {
  const out = { id: entry.id, name: namePrefix + cleanName(entry) };
  if (entry.contextWindow) out.contextWindow = entry.contextWindow;
  if (entry.maxTokens) out.maxTokens = entry.maxTokens;
  const re = reasoningEffortsOf(entry);
  if (re) out.reasoningEfforts = re;
  const mods = entry.inputModalities ?? ["text"];
  if (mods.some((m) => m !== "text")) out.input = ["text", "image"]; // pi-ai vocabulary: text/image
  return out;
}

/**
 * Map a catalog's `reasoning.supported_efforts` (e.g. ["max","high","low"]) to
 * the pi-ai settings vocabulary: a dict of level → wire value, where a value
 * identical to the level is the convention pi-ai's reasoning_effort dispatch
 * sends on the wire. Returns undefined when the catalog declares no thinking
 * support — the entry then inherits (or lacks) reasoning from the installed
 * catalog base, which is the correct fallback for a route like nous-api that
 * has no builtin provider catalog at all.
 *
 * "off" is only added when the catalog explicitly advertises a way to disable
 * thinking ("none"/"off" in supported_efforts) — writing it otherwise would
 * claim a toggling capability the vendor never declared.
 */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function reasoningEffortsOf(entry) {
  const supported = Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [];
  if (!supported.length) return undefined;
  const dict = {};
  for (const lvl of supported) {
    if (typeof lvl !== "string" || lvl === "") continue;
    if (lvl === "none" || lvl === "off") { dict.off = "none"; continue; }
    if (!THINKING_LEVELS.has(lvl)) continue;
    dict[lvl] = lvl;
  }
  // No usable levels (only "none" listed) → not a selectable-strength model.
  if (!Object.keys(dict).some((k) => k !== "off")) return undefined;
  return dict;
}

function cleanName(entry) {
  return entry.name.replace(/\s*\((free|batch)\)\s*$/i, "").trim();
}

function strip({ _rule, ...rest }) {
  return rest;
}
