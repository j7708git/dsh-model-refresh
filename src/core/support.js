// Shared low-level helpers: money parsing, stats, HTTP, atomic file IO.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** @typedef {number} PerM  price per 1M tokens in integer MICRO-dollars (1_000_000 === $1.00/M) */

/**
 * Parse an OpenRouter-style per-TOKEN price string (e.g. "0.0000008870") into
 * price per 1M tokens in MICRO dollars — an exact integer where $1.00/M =
 * 1_000_000. Per-token × 1e6 tokens = $/M; keeping micro units = × 1e12.
 * Math.round kills binary float drift at boundaries (exactly $1.00/M).
 * @returns {PerM | null} null when the field is missing/unparsable.
 */
export function usdPerMillion(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  if (!/^\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e12);
}

/** Median of numbers (ignores null/undefined entries). Returns null when empty. */
export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** GET a JSON document with bounded retries + exponential backoff. Throws on final failure. */
export async function fetchJson(url, { timeoutMs = 20_000, attempts = 3, backoffMs = 800, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "dsh-model-refresh/0.1", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * 3 ** i));
    }
  }
  throw new Error(`fetch failed after ${attempts} attempts: ${url} (${lastErr?.message ?? lastErr})`);
}

/**
 * Atomic text write: tmp file in the same directory + rename, with bounded
 * retries for transient Windows sharing violations (mirrors dsh-atomic-write).
 */
export function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, "utf8");
  const errors = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let i = 0; i < 8; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (!errors.has(err.code) || i === 7) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
      const until = Date.now() + 50 * (i + 1);
      blockSleep(until - Date.now());
    }
  }
}

/**
 * Blocking sleep via Atomics.wait — same wait semantics as a busy-wait without
 * burning CPU. Used only inside atomicWriteText's bounded Windows rename retry
 * (kept synchronous because every caller, including state.js and the CLI,
 * consumes this as a sync API).
 */
function blockSleep(ms) {
  if (ms <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, Math.min(ms, 2_147_000_000));
  } catch {
    // SharedArrayBuffer/Atomics unavailable — degrade to the old bounded spin.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* short spin */ }
  }
}

/** Atomic JSON write (tmp + rename). */
export function atomicWriteJson(path, value) {
  atomicWriteText(path, JSON.stringify(value, null, 2) + "\n");
}

/** Copy `path` into dir/<name>.<timestamp>.bak; prune to the newest `keep` of that name. */
export function backupFile(path, dir, keep = 5) {
  if (!existsSync(path)) return null;
  mkdirSync(dir, { recursive: true });
  const base = basename(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `${base}.${stamp}.bak`);
  copyFileSync(path, dest);
  const siblings = readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"))
    .sort(); // ISO stamps sort chronologically
  for (const old of siblings.slice(0, Math.max(0, siblings.length - keep))) {
    try { rmSync(join(dir, old), { force: true }); } catch { /* best effort */ }
  }
  return dest;
}

/** List backups for `path` in dir, newest first. */
export function listBackups(path, dir) {
  if (!existsSync(dir)) return [];
  const base = basename(path);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"))
    .sort()
    .reverse()
    .map((f) => join(dir, f));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
