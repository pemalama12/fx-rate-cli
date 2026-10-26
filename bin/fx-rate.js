#!/usr/bin/env node
import { fetchRates, formatRates, convert, parsePositiveInt, validateFlags, formatCliError, parseAmounts, parseRateOverride, defaultHistoryCacheDir, listHistoryCache, fetchHistoricalRate, clearCache, clearHistoryCache } from "../src/index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const watchArg = args.find((a) => a === "--watch" || a.startsWith("--watch="));
const watchSecs = watchArg ? parsePositiveInt(watchArg.includes("=") ? watchArg.split("=")[1] : "30", 30) : 0;
const intervalArg = args.find((a) => a === "--interval" || a.startsWith("--interval="));
const intervalSecs = intervalArg ? parsePositiveInt(intervalArg.includes("=") ? intervalArg.split("=")[1] : "30", 30) : 0;
const countArg = args.find((a) => a.startsWith("--count="));
const maxTicks = countArg ? parsePositiveInt(countArg.split("=")[1], 0) : 0;
const dateArg = args.find((a) => a.startsWith("--date="));
const date = dateArg ? dateArg.split("=")[1] : null;
const clearCacheFlag = args.includes("--clear-cache");
const dumpCacheFlag = args.includes("--dump-cache");
const filtered = args.filter((a) => !a.startsWith("--") );
const base = (filtered[0] || "EUR").toUpperCase();
const targets = (filtered[1] || "USD").split(",").map((s) => s.trim()).filter(Boolean);
const amountArg = args.find((a) => a.startsWith("--amount="));
const amountFlag = amountArg ? amountArg.split("=")[1] : null;
const parsedAmounts = parseAmounts(filtered.slice(2), amountFlag);
if (!parsedAmounts.ok) { console.error(`error: ${parsedAmounts.error}`); process.exit(2); }
const amounts = parsedAmounts.amounts;
const rateArg = args.find((a) => a.startsWith("--rate="));
const parsedRate = parseRateOverride(rateArg ? rateArg.split("=")[1] : null);
if (!parsedRate.ok) { console.error(`error: ${parsedRate.error}`); process.exit(2); }
const rateOverride = parsedRate.rate;
if (rateOverride !== null && targets.length > 1) {
  console.error("error: --rate applies to a single target only");
  process.exit(2);
}

const err = validateFlags({ watchSecs: watchSecs || intervalSecs, date });
if (err) { console.error(`error: ${err}`); process.exit(1); }

if (args.includes("--version")) {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`fx-rate-cli ${pkg.version}`);
  process.exit(0);
}

if (args.includes("-h") || args.includes("--help")) {
  console.log(`fx-rate - fetch foreign-exchange rates (Frankfurter, no API key)

Usage:
  fx-rate [BASE] [TARGETS] [options]

Examples:
  fx-rate EUR USD
  fx-rate USD "EUR,GBP,BRL" --json
  fx-rate EUR USD --amount=100
  fx-rate EUR USD 100 250
  fx-rate EUR USD --rate=1.1 --amount=100
  fx-rate EUR USD --date=2026-10-20
  fx-rate EUR USD --watch=30 --count=5

Options:
  --amount=N       Convert N units of BASE into TARGETS (also: positional amounts)
  --rate=R         Override the rate (single target only; skips the network)
  --date=YYYY-MM-DD Historical rate on that date (cached on disk)
  --watch[=SECS]   Refresh continuously (default 30s)
  --interval=SECS  Alias for --watch=SECS
  --count=N        Stop after N refreshes
  --clear-cache    Wipe the on-disk history cache and exit
  --dump-cache     List cached historical rates and exit
  --json           Machine-readable JSON output
  --version        Print version and exit
  -h, --help       Show this help

Exit codes:
  0                Success
  1                API/network error or incompatible flags
  2                Invalid amount or rate

Unexpected stack traces indicate a bug worth reporting.
`);
  process.exit(0);
}

if (clearCacheFlag) {
  const dir = defaultHistoryCacheDir();
  try {
    await clearHistoryCache(dir);
    console.log("cleared");
  } catch (error) {
    console.error(formatCliError(error));
    process.exitCode = 1;
  }
  process.exit(0);
}

if (dumpCacheFlag) {
  const entries = await listHistoryCache(defaultHistoryCacheDir());
  if (json) console.log(JSON.stringify(entries, null, 2));
  else if (entries.length === 0) console.log("history cache is empty");
  else for (const e of entries) console.log(`${e.base} on ${e.date}: ${e.currencies.join(", ")}`);
  process.exit(0);
}

async function tick() {
  if (date) {
    const data = await fetchHistoricalRate(base, date, targets);
    if (json) console.log(JSON.stringify(data, null, 2));
    else console.log(`${data.base} on ${data.date}: ${Object.entries(data.rates).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  } else if (rateOverride !== null) {
    const t = targets[0];
    if (amounts.length > 0) {
      for (const a of amounts) console.log(`${a} ${base} = ${convert(a, rateOverride).toFixed(4)} ${t} (override)`);
    } else if (json) {
      console.log(JSON.stringify({ base, target: t, rate: rateOverride, source: "override" }, null, 2));
    } else {
      console.log(`${base} on override: ${t}=${rateOverride}`);
    }
  } else {
    const data = await fetchRates(base, targets);
    if (amounts.length > 0) {
      for (const t of targets) {
        const rate = data.rates[t];
        if (rate === undefined) continue;
        for (const a of amounts) console.log(`${a} ${base} = ${convert(a, rate).toFixed(4)} ${t}`);
      }
    } else {
      if (json) console.log(JSON.stringify(data, null, 2));
      else console.log(formatRates(data));
    }
  }
}

const secs = watchSecs || intervalSecs;
try {
  if (secs > 0) {
    const { watchPrices } = await import("../src/index.js").then((m) => ({ watchPrices: m.watchPrices })).catch(() => ({ watchPrices: null }));
    // inline watch loop to avoid import cycle
    let t = 0;
    const max = maxTicks > 0 ? maxTicks : Infinity;
    while (t < max) {
      t++;
      await tick();
      if (t >= max) break;
      await new Promise((r) => setTimeout(r, secs * 1000));
    }
  } else {
    await tick();
  }
} catch (error) {
  console.error(formatCliError(error));
  process.exitCode = 1;
}
