import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/fx-rate.js", import.meta.url));
const data = { base: "EUR", date: "2026-10-25", rates: { USD: 1.1 } };
const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(data)}));`)}`;

function run(...args) {
  const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("--jsonl emits one compact JSON line", () => {
  assert.equal(run("EUR", "USD", "--jsonl"), JSON.stringify(data) + "\n");
});

test("--jsonl takes precedence over --json", () => {
  assert.equal(run("EUR", "USD", "--json", "--jsonl"), JSON.stringify(data) + "\n");
});

test("--jsonl --watch honors --count", () => {
  const output = run("EUR", "USD", "--jsonl", "--watch=1", "--count=2");
  assert.equal(output, (JSON.stringify(data) + "\n").repeat(2));
  assert.deepEqual(output.trim().split("\n").map((line) => JSON.parse(line)), [data, data]);
});

test("--jsonl emits one object for multiple conversion amounts", () => {
  const output = run("EUR", "USD", "100", "250", "--jsonl");
  assert.equal(output.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(output), {
    ...data,
    conversions: [
      { amount: 100, target: "USD", value: 100 * 1.1 },
      { amount: 250, target: "USD", value: 250 * 1.1 },
    ],
  });
});

test("--jsonl supports offline rate overrides and conversion amounts", () => {
  const output = run("EUR", "USD", "--rate=1.1", "--amount=100", "--jsonl");
  assert.deepEqual(JSON.parse(output), {
    base: "EUR", target: "USD", rate: 1.1, source: "override",
    conversions: [{ amount: 100, target: "USD", value: 100 * 1.1 }],
  });
});

test("--json retains pretty output", () => {
  assert.equal(run("EUR", "USD", "--json"), JSON.stringify(data, null, 2) + "\n");
});

test("--help documents --jsonl", () => {
  assert.match(run("--help"), /--jsonl/);
});
