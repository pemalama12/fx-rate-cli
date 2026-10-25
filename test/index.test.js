import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveCurrency,
  fetchRates,
  convert,
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

test("fetchWithRetry honors Retry-After", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, statusText: "Too Many", headers: { get: () => "2" }, json: async () => ({}) };
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };
  const sleeps = [];
  await fetchWithRetry(fetchImpl, "u", {}, { sleepImpl: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
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

test("historyCacheFile rejects bad date", () => {
  assert.throws(() => historyCacheFile("/tmp", "EUR", "2026/10/20"), /dateStr must be/);
});

test("listHistoryCache enumerates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-list-"));
  assert.deepEqual(await listHistoryCache(dir), []);
  await writeHistoryCache(dir, "eur", "2026-10-20", { USD: 1.08, BRL: 5.4 });
  assert.deepEqual(await listHistoryCache(dir), [{ base: "EUR", date: "2026-10-20", currencies: ["BRL", "USD"] }]);
});
