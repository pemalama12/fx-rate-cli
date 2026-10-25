import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveCurrency,
  fetchRates,
  convert,
  parseAmounts,
  formatRates,
  parsePositiveInt,
  validateFlags,
  clearCache,
  fetchWithRetry,
  historyCacheFile,
  readHistoryCache,
  writeHistoryCache,
  defaultHistoryCacheDir,
  fetchHistoricalRate,
  listHistoryCache,
} from "../src/index.js";

test("resolveCurrency uppercases and trims", () => {
  assert.equal(resolveCurrency("  usd "), "USD");
  assert.equal(resolveCurrency("eur"), "EUR");
});

test("fetchRates returns rates and caches", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ base: "EUR", date: "2026-10-25", rates: { USD: 1.08, BRL: 5.4 } }) };
  };
  clearCache();
  const a = await fetchRates("eur", ["usd", "brl"], fetchImpl);
  assert.equal(a.base, "EUR");
  assert.equal(a.rates.USD, 1.08);
  const b = await fetchRates("EUR", ["USD", "BRL"], fetchImpl, { cacheTtlMs: 60000 });
  assert.equal(calls, 1);
  assert.deepEqual(b, a);
});

test("fetchRates evicts the least recently used entry at the configured size", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const base = new URL(url).searchParams.get("from");
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ base, date: "2026-10-25", rates: { USD: 1 } }) };
  };
  clearCache();
  const options = { cacheMaxSize: 2, cacheTtlMs: 60000 };
  await fetchRates("EUR", ["USD"], fetchImpl, options);
  await fetchRates("GBP", ["USD"], fetchImpl, options);
  await fetchRates("EUR", ["USD"], fetchImpl, options);
  await fetchRates("JPY", ["USD"], fetchImpl, options);
  await fetchRates("GBP", ["USD"], fetchImpl, options);
  assert.equal(calls, 4);
});

test("fetchRates defaults to a 100-entry LRU cache", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ rates: { USD: 1 } }) };
  };
  clearCache();
  for (let i = 0; i < 100; i++) {
    await fetchRates(`C${String(i).padStart(3, "0")}`, ["USD"], fetchImpl);
  }
  await fetchRates("C000", ["USD"], fetchImpl);
  await fetchRates("C100", ["USD"], fetchImpl);
  await fetchRates("C001", ["USD"], fetchImpl);
  assert.equal(calls, 102);
});

test("fetchRates shares cache across case variants", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ base: "EUR", date: "2026-10-25", rates: { USD: 1.08 } }) };
  };
  clearCache();
  await fetchRates("eur", ["usd"], fetchImpl);
  await fetchRates("EUR", ["USD"], fetchImpl, { cacheTtlMs: 60000 });
  assert.equal(calls, 1);
});

test("errors never include the request URL or query string", async () => {
  const fetchImpl = async (url) => {
    if (!String(url).includes("api.frankfurter.app")) throw new Error("wrong host: " + url);
    return { ok: false, status: 500, statusText: "Oops", headers: { get: () => null }, json: async () => ({}) };
  };
  clearCache();
  const err = await fetchRates("EUR", ["USD"], fetchImpl, { retries: 0 }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /api\.frankfurter|\?|from=|to=/);
});

test("fetchRates throws on bad response", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}) });
  clearCache();
  await assert.rejects(() => fetchRates("EUR", ["USD"], fetchImpl), /Unexpected response/);
});

test("convert multiplies amount by rate", () => {
  assert.equal(convert(100, 5.4), 540);
  assert.throws(() => convert("x", 5), /amount must be/);
  assert.throws(() => convert(1, NaN), /rate must be/);
});

test("formatRates renders base/date and rates", () => {
  const out = formatRates({ base: "EUR", date: "2026-10-25", rates: { USD: 1.08 } });
  assert.match(out, /EUR on 2026-10-25:/);
  assert.match(out, /USD: 1.08/);
});

test("formatRates marks missing rates as n/a", () => {
  const out = formatRates({ base: "EUR", date: "2026-10-25", rates: { USD: undefined } });
  assert.match(out, /USD: n\/a/);
});

test("parsePositiveInt", () => {
  assert.equal(parsePositiveInt("30", 5), 30);
  assert.equal(parsePositiveInt("0", 5), 5);
  assert.equal(parsePositiveInt("abc", 5), 5);
  assert.equal(parsePositiveInt("", 5), 5);
});

test("validateFlags", () => {
  assert.equal(validateFlags({ watchSecs: 5, date: "2026-10-25" }), "--watch and --date cannot be combined.");
  assert.equal(validateFlags({ watchSecs: 5 }), null);
});

test("fetchWithRetry applies jitter within bounds", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n <= 2) return { ok: false, status: 500, statusText: "Err", headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, retryBaseMs: 1000, jitter: true });
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.ok(ms >= 800 && ms <= 2400, `out of range: ${ms}`);
  assert.ok(sleeps[0] !== 1000 || sleeps[1] !== 2000, "jitter must perturb deterministic backoff");
});

test("fetchWithRetry jitter disabled keeps exact backoff", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n <= 2) return { ok: false, status: 500, statusText: "Err", headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, retryBaseMs: 1000, jitter: false });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("fetchWithRetry honors Retry-After", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, statusText: "Too Many", headers: { get: () => "2" }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); }, jitter: false });
  assert.deepEqual(sleeps, [2000]);
});

test("history cache union across currencies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-hist-"));
  await writeHistoryCache(dir, "eur", "2026-10-20", { USD: 1.08 });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ base: "EUR", date: "2026-10-20", rates: { USD: 1.08, BRL: 5.4 } }) };
  };
  const opts = { cacheDir: dir };
  const a = await fetchHistoricalRate("eur", "2026-10-20", ["USD", "BRL"], fetchImpl, opts);
  assert.equal(calls, 1);
  assert.equal(a.rates.BRL, 5.4);
  const b = await fetchHistoricalRate("EUR", "2026-10-20", ["USD"], fetchImpl, opts);
  assert.equal(calls, 1);
  assert.equal(b.rates.USD, 1.08);
});

test("historyCacheFile blocks path traversal in base", () => {
  assert.throws(() => historyCacheFile("/tmp/cache", "../etc", "2026-10-26"), /base must be/);
  assert.throws(() => historyCacheFile("/tmp/cache", "eur/../x", "2026-10-26"), /base must be/);
  assert.throws(() => historyCacheFile("/tmp/cache", "", "2026-10-26"), /base must be/);
  assert.equal(historyCacheFile("/tmp/cache", "eur", "2026-10-26"), "/tmp/cache/EUR-2026-10-26.json");
});

test("historyCacheFile rejects bad date", () => {
  assert.throws(() => historyCacheFile("/tmp", "EUR", "2026/10/20"), /dateStr must be/);
});

test("listHistoryCache enumerates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-list-"));
  assert.deepEqual(await listHistoryCache(dir), []);
  await writeHistoryCache(dir, "eur", "2026-10-20", { USD: 1.08, BRL: 5.4 });
  assert.deepEqual(await listHistoryCache(dir), [{ base: "EUR", date: "2026-10-20", currencies: ["BRL", "USD"] }]);
});

test("parseAmounts handles positional, comma and --amount= forms", () => {
  assert.deepEqual(parseAmounts([], null), { ok: true, amounts: [] });
  assert.deepEqual(parseAmounts(["100", "250"], null), { ok: true, amounts: [100, 250] });
  assert.deepEqual(parseAmounts(["100,250"], null), { ok: true, amounts: [100, 250] });
  assert.deepEqual(parseAmounts([], "50"), { ok: true, amounts: [50] });
  assert.deepEqual(parseAmounts(["100"], "50"), { ok: true, amounts: [100, 50] });
});

test("parseAmounts rejects invalid values fail-fast", () => {
  assert.deepEqual(parseAmounts(["abc"], null), { ok: false, error: "invalid amount: abc" });
  assert.deepEqual(parseAmounts(["-5"], null), { ok: false, error: "invalid amount: -5" });
});
