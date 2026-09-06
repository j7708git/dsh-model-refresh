// Update rules: R2 pins (§7.2), R1 free pool (§7.1), R3 smart candidates (§7.3).
// All functions are pure (state/hysteresis passed in explicitly) so planner tests
// need no network and no files.

/**
 * R2 — resolve the configured pins against one provider's live pool.
 * First candidate id that exists wins; missing pins are reported so the caller
 * can retain the previous entry instead of silently dropping a pin.
 * @returns {{resolved: Array<{pinKey: string, entry: import('./catalog.js').CatalogEntry}>, missing: string[]}}
 */
export function resolvePins(cfg, pool, provider) {
  const byId = new Map(pool.map((e) => [e.id, e]));
  const resolved = [];
  const missing = [];
  for (const pin of cfg.pins) {
    const candidates = pin.byProvider?.[provider] ?? [];
    const entry = candidates.map((id) => byId.get(id)).find(Boolean) ?? null;
    if (entry) resolved.push({ pinKey: pin.key, entry });
    else missing.push(pin.key);
  }
  return { resolved, missing };
}

/** Capability score in [0..~120]; baseline = the pins' median AA profile (100). */
export function makeScorer(cfg, pool, resolvedPins) {
  const pinEntries = resolvedPins.map((r) => r.entry);
  const baseline = {
    intelligence: medianOf(pinEntries.map((e) => e.benchmarks.intelligence)),
    coding: medianOf(pinEntries.map((e) => e.benchmarks.coding)),
    agentic: medianOf(pinEntries.map((e) => e.benchmarks.agentic)),
  };

  /** @returns {{score: number, unverified: boolean, basis: string[]}} */
  return function score(entry) {
    const w = cfg.candidates.weights;
    const basis = [];
    let sum = 0;
    let weightUsed = 0;
    for (const dim of ["intelligence", "coding", "agentic"]) {
      const v = entry.benchmarks[dim];
      const b = baseline[dim];
      if (typeof v === "number" && typeof b === "number" && b > 0) {
        sum += w[dim] * (v / b) * 100;
        weightUsed += w[dim];
        basis.push(`${dim}=${v}`);
      }
    }
    if (weightUsed > 0) return { score: round1(sum / weightUsed), unverified: false, basis };
    // -- proxy score for models without AA indices --------------------------------
    const flags = [];
    if ((entry.contextWindow ?? 0) >= 1_000_000) flags.push("ctx>=1M");
    if (entry.reasoningEfforts.length >= 3) flags.push("multi-effort reasoning");
    if (/terminal-bench|swe-bench|agentic coding|coding agent/i.test(entry.description)) flags.push("coding-agent claim");
    if (/benchmark|leaderboard|\d+(\.\d+)?%/i.test(entry.description)) flags.push("benchmark mention");
    if (entry.huggingFaceId) flags.push("open-weights");
    const proxy = Math.min(92, 55 + flags.length * 9); // 55..92 → below the 95 qualify line on its own
    return { score: proxy, unverified: true, basis: flags.length ? [`proxy: ${flags.join(", ")}`] : ["no signals"] };
  };
}

function medianOf(nums) {
  const v = nums.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Model family key: strips variant suffixes, router prefix, date snapshots and
 * version digits so that "deepseek/deepseek-v4-flash-0731", "~deepseek/deepseek-v4-flash-latest"
 * and "qwen/qwen3.8-flash" vs "qwen3.7-flash" resolve per intent:
 * same-family candidates behind a pin are redundant → excluded.
 */
export function familyOf(id) {
  return String(id)
    .replace(/^~/, "")
    .replace(/:(free|batch)$/i, "")
    .replace(/-\d{3,8}$/, "")
    .replace(/-(latest|newest)$/i, "")
    .replace(/\d+(?:\.\d+)*/g, "n")
    .toLowerCase();
}

/** Shared structural filter used by R1 and R3: text output, tools, enough context. */
export function structurallyEligible(entry, minContext) {
  if (!entry.outputsText || !entry.supportsTools) return false;
  if ((entry.contextWindow ?? 0) < minContext) return false;
  return true;
}

/**
 * R1 — select the free entries for one provider.
 * Accepts zero-priced base or :free variants (preferring the :free id when the
 * paid twin exists), excludes routers/batch, ranks by capability score, caps at
 * `maxPerProvider`, boosts Portal-recommended ids.
 * @param takenIds ids already claimed by pins/candidates (never re-offered as free)
 * @returns Array<{entry, score: number, boosted: boolean}>
 */
export function selectFree(cfg, pool, score, takenIds, suppressed = new Set()) {
  const c = cfg.free;
  const byId = new Map(pool.map((e) => [e.id, e]));
  const out = [];
  for (const e of pool) {
    if (takenIds.has(e.id) || suppressed.has(e.id)) continue;
    if (!e.free) continue;
    if (e.variant !== "free" && e.variant !== "base") continue;
    // prefer the ":free" spelling of the same slug when both exist
    if (e.variant === "base") {
      const freeTwin = byId.get(`${e.id}:free`);
      if (freeTwin && !takenIds.has(freeTwin.id)) continue;
    }
    if (!structurallyEligible(e, c.minContext)) continue;
    const s = score(e);
    out.push({ entry: e, score: s.score, boosted: e.portalRecommendedFree });
  }
  out.sort((a, b) => (Number(b.boosted) - Number(a.boosted)) || (b.score - a.score) || (b.entry.contextWindow - a.entry.contextWindow));
  return out.slice(0, c.maxPerProvider);
}

/**
 * R3 — candidate pool with hard price/context filter + family dedup, then
 * hysteresis (incumbent protection, swapFactor, behindNeeded, cooldown) against
 * the persisted ledger.
 *
 * @param ledger {incumbents: {id: {score, enteredAt(iso), behind}}, ...} current provider ledger (mutated copy returned)
 * @returns {{entries: Array<{entry, score, unverified, basis}>, notes: string[], ledger: object}}
 */
export function selectCandidates(cfg, pool, score, takenIds, { nowMs, ledger, provider, excludePinIds, suppressed = new Set() }) {
  const c = cfg.candidates;
  const excl = c.excludeIdPattern ? new RegExp(c.excludeIdPattern, "i") : null;
  const pinFamilies = new Set([...excludePinIds].map(familyOf));
  const qualified = [];
  const priceFlags = new Set();
  const familySkips = new Set();

  for (const e of pool) {
    if (takenIds.has(e.id) || excludePinIds.has(e.id) || suppressed.has(e.id)) continue;
    if (e.variant !== "base" && e.variant !== "free") continue;
    if (e.free) continue; // free models belong to R1
    if (!structurallyEligible(e, c.minContext)) continue;
    if (excl && excl.test(e.id)) continue;
    if (e.inPerM == null || e.outPerM == null) continue;
    if (e.inPerM > c.maxPricePerM || e.outPerM > c.maxPricePerM) continue; // 規則甲：第一檔
    if (pinFamilies.has(familyOf(e.id))) { familySkips.add(e.id); continue; } // same family as a pin → redundant
    for (const t of e.priceTiers) {
      if ((t.inPerM ?? 0) > c.maxPricePerM || (t.outPerM ?? 0) > c.maxPricePerM) priceFlags.add(e.id);
    }
    qualified.push(e);
  }

  // dedup per family: keep best score (tie → newer)
  const best = new Map();
  for (const e of qualified) {
    const key = familyOf(e.id);
    const s = score(e);
    const prev = best.get(key);
    if (!prev || s.score > prev.score || (s.score === prev.score && e.created > prev.entry.created)) {
      best.set(key, { entry: e, ...s });
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);

  // split: qualifying (score ≥ baseline×factor, or AA-backed) vs proxy-only
  const qualifyLine = c.qualifyFactor * 100;
  const strong = ranked.filter((r) => !r.unverified && r.score >= qualifyLine);
  const unverified = ranked.filter((r) => r.unverified);
  const weak = ranked.filter((r) => !r.unverified && r.score < qualifyLine);

  const notes = [];
  if (familySkips.size) notes.push(`excluded (same family as a pin): ${[...familySkips].join(", ")}`);
  for (const e of priceFlags) notes.push(`tiered price above $1/M at higher tiers (noted only): ${e}`);
  for (const r of weak) notes.push(`below capability line (${r.score} < ${qualifyLine}): ${r.entry.id}`);

  // ---- hysteresis bookkeeping -------------------------------------------------
  const L = structuredClone(ledger ?? { incumbents: {} });
  const byId = new Map(ranked.map((r) => [r.entry.id, r]));
  const hardGone = [];
  for (const id of Object.keys(L.incumbents)) {
    if (!byId.has(id)) { hardGone.push(id); delete L.incumbents[id]; }
  }
  if (hardGone.length) notes.push(`incumbents dropped by hard filter: ${hardGone.join(", ")}`);

  const chosen = Object.keys(L.incumbents).map((id) => ({ ...byId.get(id), id }));
  const poolRest = strong.filter((r) => !(r.entry.id in L.incumbents));
  const fillPool = [...poolRest];
  if (chosen.length < c.min && c.fallbackToUnverified) {
    // pad with best proxy picks so the target count is reachable
    fillPool.push(...unverified.filter((r) => !(r.entry.id in L.incumbents)));
  }
  while (chosen.length < c.target && fillPool.length) {
    const r = fillPool.shift();
    L.incumbents[r.entry.id] = { score: r.score, enteredAt: new Date(nowMs).toISOString(), behind: 0 };
    chosen.push(r);
    notes.push(`candidate admitted: ${r.entry.id} (score ${r.score}${r.unverified ? ", unverified" : ""})`);
  }

  // replacement pressure: best challenger vs weakest incumbent
  const challengers = [...strong, ...(c.fallbackToUnverified ? unverified : [])].filter(
    (r) => !(r.entry.id in L.incumbents),
  );
  if (chosen.length > 0 && challengers.length > 0) {
    const weakest = chosen.reduce((a, b) => (a.score < b.score ? a : b));
    const bestCh = challengers[0];
    const incumbentMeta = L.incumbents[weakest.entry.id];
    if (bestCh.score >= weakest.score * c.hysteresis.swapFactor) {
      incumbentMeta.behind += 1;
      const cooled = nowMs - Date.parse(incumbentMeta.enteredAt) >= c.hysteresis.cooldownDays * 86_400_000;
      if (incumbentMeta.behind >= c.hysteresis.behindNeeded && cooled) {
        notes.push(`incumbent out: ${weakest.entry.id} (behind ${incumbentMeta.behind} cycles) → in: ${bestCh.entry.id} (score ${bestCh.score})`);
        delete L.incumbents[weakest.entry.id];
        L.incumbents[bestCh.entry.id] = { score: bestCh.score, enteredAt: new Date(nowMs).toISOString(), behind: 0 };
        const wi = chosen.indexOf(weakest);
        chosen.splice(wi, 1, bestCh);
      } else {
        notes.push(`replacement pressure on ${weakest.entry.id}: challenger ${bestCh.entry.id} (behind ${incumbentMeta.behind}/${c.hysteresis.behindNeeded}${cooled ? "" : ", cooldown"})`);
      }
    } else {
      for (const inc of chosen) L.incumbents[inc.entry.id].behind = 0;
    }
  }

  while (chosen.length > c.max) {
    const worst = chosen.reduce((a, b) => (a.score < b.score ? a : b));
    notes.push(`over target, trimmed: ${worst.entry.id}`);
    delete L.incumbents[worst.entry.id];
    chosen.splice(chosen.indexOf(worst), 1);
  }

  if (chosen.length < c.min) {
    notes.push(`WARNING: only ${chosen.length} candidate(s) qualified (min ${c.min}) — pool may lack models meeting both price and capability lines`);
  }
  return { entries: chosen, notes, ledger: L };
}
