// fx-rate-cli: fetch foreign-exchange rates from Frankfurter (no API key).

const API_URL = "https://api.frankfurter.app";

/**
 * Build a Frankfurter request URL. All request URLs go through here so
 * error paths never need to handle (or leak) query strings: failures
 * report only host + HTTP status.
 */
export function buildFrankfurterUrl(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return qs ? `${API_URL}${path}?${qs}` : `${API_URL}${path}`;
}

export function resolveCurrency(input) {
  return String(input || "").trim().toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(fetchImpl, url, init, options = {}) {
  const retries = typeof options.retries === "number" ? options.retries : 3;
  const baseMs = typeof options.retryBaseMs === "number" ? options.retryBaseMs : 1000;
  const jitter = options.jitter !== false;
  const sleepImpl = options.sleepImpl || sleep;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      await sleepImpl(withJitter(baseMs * 2 ** attempt, jitter));
      continue;
    }
    if (res.ok) return res;
    lastError = new Error(`Frankfurter request failed: ${res.status} ${res.statusText}`);
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === retries) break;
    let waitMs = baseMs * 2 ** attempt;
    const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) waitMs = Math.min(secs * 1000, 60000);
    }
    await sleepImpl(withJitter(waitMs, jitter));
  }
  throw lastError;
}

function withJitter(ms, jitter) {
  if (!jitter) return ms;
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

const cache = new Map();
function cacheKey(base, targets) {
  return `${base}|${targets.join(",")}`;
}

export async function fetchRates(base = "EUR", targets = ["USD"], fetchImpl = fetch, options = {}) {
  base = resolveCurrency(base);
  targets = (Array.isArray(targets) ? targets : [targets]).map(resolveCurrency).filter(Boolean);
  if (targets.length === 0) throw new Error("targets must be a non-empty array");
  const ttl = typeof options.cacheTtlMs === "number" ? options.cacheTtlMs : 60000;
  const maxSize = typeof options.cacheMaxSize === "number" && Number.isFinite(options.cacheMaxSize)
    ? Math.max(0, Math.floor(options.cacheMaxSize))
    : 100;
  const key = cacheKey(base, targets);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.data;
  }
  if (cached) cache.delete(key);
  const url = buildFrankfurterUrl("/latest", { from: base, to: targets.join(",") });
  const res = await fetchWithRetry(fetchImpl, url, { headers: { accept: "application/json" } }, options);
  if (!res.ok) throw new Error(`Frankfurter request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data || typeof data.rates !== "object") throw new Error("Unexpected response from Frankfurter");
  cache.set(key, { ts: Date.now(), data });
  while (cache.size > maxSize) cache.delete(cache.keys().next().value);
  return data;
}

export function clearCache() { cache.clear(); }

export function convert(amount, rate) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error("amount must be a finite number");
  if (!Number.isFinite(rate)) throw new Error("rate must be a finite number");
  return n * rate;
}

export function formatRates(data) {
  const base = data.base;
  const date = data.date;
  const lines = [`${base} on ${date}:`];
  for (const [cur, rate] of Object.entries(data.rates || {})) {
    lines.push(`  ${cur}: ${rate === undefined ? "n/a" : rate}`);
  }
  return lines.join("\n");
}

export function parsePositiveInt(raw, def) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export function validateFlags({ watchSecs = 0, date = null } = {}) {
  if (watchSecs > 0 && date) {
    return "--watch and --date cannot be combined.";
  }
  return null;
}

/**
 * Parse an explicit --rate=R override for offline / what-if conversions.
 * Returns { ok:true, rate } with rate null when unset, or { ok:false, error }.
 */
export function parseRateOverride(raw) {
  if (raw === null || raw === undefined) return { ok: true, rate: null };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `invalid rate: ${raw}` };
  }
  return { ok: true, rate: n };
}

/**
 * Parse user-supplied amounts (positional extras + legacy --amount=).
 * Returns { ok:true, amounts:[...] } or { ok:false, error }.
 * Fail-fast: invalid values are reported before any fetch happens.
 */
export function parseAmounts(positionalExtras = [], amountFlag = null) {
  const raw = [...positionalExtras];
  if (amountFlag !== null && amountFlag !== undefined) raw.push(String(amountFlag));
  if (raw.length === 0) return { ok: true, amounts: [] };
  const amounts = [];
  for (const item of String(raw.join(",")).split(",")) {
    const value = item.trim();
    if (value === "") continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `invalid amount: ${value}` };
    }
    amounts.push(n);
  }
  if (amounts.length === 0) return { ok: true, amounts: [] };
  return { ok: true, amounts };
}

// --- disk cache for historical rates ---
export function historyCacheFile(dir, base, dateStr) {
  const normalized = String(base).trim().toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(normalized)) throw new Error("base must be a 2-5 letter currency code");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error("dateStr must be YYYY-MM-DD");
  return `${dir}/${normalized}-${dateStr}.json`;
}

export async function readHistoryCache(dir, base, dateStr) {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(historyCacheFile(dir, base, dateStr), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeHistoryCache(dir, base, dateStr, rates) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(historyCacheFile(dir, base, dateStr), JSON.stringify(rates));
}

export function defaultHistoryCacheDir() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const base = process.env.XDG_CACHE_HOME || `${home}/.cache`;
  return `${base}/fx-rate-cli/history`;
}

export async function fetchHistoricalRate(base, dateStr, targets = ["USD"], fetchImpl = fetch, options = {}) {
  base = resolveCurrency(base);
  targets = (Array.isArray(targets) ? targets : [targets]).map(resolveCurrency).filter(Boolean);
  if (targets.length === 0) throw new Error("targets must be a non-empty array");
  const cacheDir = options && options.cacheDir !== undefined ? options.cacheDir : defaultHistoryCacheDir();
  let union = null;
  if (cacheDir) {
    union = await readHistoryCache(cacheDir, base, dateStr);
    if (union && targets.every((t) => union[t] !== undefined)) {
      const out = {};
      for (const t of targets) out[t] = union[t];
      return { base, date: dateStr, rates: out };
    }
  }
  const url = buildFrankfurterUrl(`/${dateStr}`, { from: base, to: targets.join(",") });
  const res = await fetchWithRetry(fetchImpl, url, { headers: { accept: "application/json" } }, options || {});
  if (!res.ok) throw new Error(`Frankfurter request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data || typeof data.rates !== "object") throw new Error("No rates for that date");
  const out = {};
  for (const t of targets) {
    if (data.rates[t] !== undefined) out[t] = data.rates[t];
  }
  if (cacheDir) {
    await writeHistoryCache(cacheDir, base, dateStr, { ...(union || {}), ...out });
  }
  return { base: data.base || base, date: data.date || dateStr, rates: out };
}

export async function listHistoryCache(dir) {
  const { readdir, readFile } = await import("node:fs/promises");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files.sort()) {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    try {
      const data = JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
      out.push({ base: m[1], date: m[2], currencies: Object.keys(data || {}).sort() });
    } catch { continue; }
  }
  return out;
}
