// Run:  npm test   (or: node --test tests/)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LLMError } from "../src/llm.js";
import { extractEvidence, normalize, parseLogs, selectExcerpt } from "../src/parser.js";
import { InputError, analyze, grounded, toMarkdown } from "../src/pipeline.js";
import { baselineSeverity } from "../src/rules.js";

const sample = (name) => readFileSync(new URL(`../sample_logs/${name}`, import.meta.url), "utf8");

describe("parser", () => {
  test("parses common formats", () => {
    const text = [
      "2026-10-22 14:00:06,836 ERROR [payment-service] Timeout talking to db",
      "2026-10-22T14:00:07Z WARN cache slow service=catalog",
      '{"timestamp":"2026-10-22T14:00:08Z","level":"error","service":"auth","message":"401 invalid token"}',
      "something ERROR without timestamp",
      "random noise line",
    ].join("\n");
    const { entries, unparsed } = parseLogs(text);
    assert.equal(entries.length, 4);
    assert.equal(unparsed, 1);
    assert.equal(entries[0].service, "payment-service");
    assert.equal(entries[1].service, "catalog");
    assert.equal(entries[2].level, "ERROR");
    assert.equal(entries[2].service, "auth");
  });

  test("stack trace lines attach to the parent entry", () => {
    const text = "2026-10-22 14:00:06 ERROR [svc] boom\n\tat com.x.Y.z(Y.java:1)\n"
      + "Caused by: java.sql.SQLException: pool exhausted\n";
    const { entries, unparsed } = parseLogs(text);
    assert.equal(entries.length, 1);
    assert.equal(unparsed, 0);
    assert.equal(entries[0].trace.length, 2);
  });

  test("normalize groups variable parts", () => {
    assert.equal(normalize("txn=TXN-123456 failed after 30000ms from 10.0.0.1:443"),
                 normalize("txn=TXN-999999 failed after 12ms from 192.168.1.9:80"));
  });

  test("repeated failures are counted", () => {
    const ev = extractEvidence(sample("payment_db_outage.log"));
    assert.match(ev.top_signatures[0].signature, /JDBC Connection/);
    assert.equal(ev.top_signatures[0].count, 14);
    assert.equal(ev.unparsed_lines, 0);
    assert.ok(ev.categories.db_connection);
  });

  test("recovery signals are detected", () => {
    const ev = extractEvidence(sample("minor_warnings.jsonl"));
    assert.equal(ev.recovery_signals.count, 1);
    assert.match(ev.recovery_signals.examples[0], /succeeded/);
  });

  test("excerpt respects budget and keeps errors", () => {
    const excerpt = selectExcerpt(sample("payment_db_outage.log").repeat(20), 3000);
    assert.ok(excerpt.length <= 3200);
    assert.match(excerpt, /ERROR/);
  });
});

describe("severity", () => {
  // Expected baseline severity for each simulated scenario.
  const cases = {
    "payment_db_outage.log": "Critical",
    "checkout_memory_leak.log": "Critical",
    "cache_latency_degraded.log": "Medium",
    "minor_warnings.jsonl": "Low",
  };
  for (const [name, expected] of Object.entries(cases)) {
    test(`${name} -> ${expected}`, () => {
      const { level, reasons } = baselineSeverity(extractEvidence(sample(name)));
      assert.equal(level, expected, reasons.join("; "));
    });
  }
});

describe("pipeline", () => {
  test("grounding flags invented claims", () => {
    const logs = sample("payment_db_outage.log").toLowerCase();
    assert.ok(grounded("Unable to acquire JDBC Connection from HikariPool", logs));
    assert.ok(!grounded("Kafka broker partition rebalance storm", logs));
  });

  test("falls back to rules when Ollama is down", async () => {
    const chat = async () => { throw new LLMError("connection refused"); };
    const result = await analyze(sample("payment_db_outage.log"), { chat });
    assert.equal(result.report.source, "rules");
    assert.match(result.report.note, /unavailable/);
    assert.match(result.report.likely_cause.hypothesis.toLowerCase(), /database/);
  });

  test("malformed model output is normalized", async () => {
    const bad = { severity: { level: "catastrophic" }, likely_cause: "db", key_errors: "x",
                  troubleshooting_steps: ["restart it"] };
    const chat = async () => ({ data: bad, meta: { model: "fake" } });
    const result = await analyze(sample("cache_latency_degraded.log"), { chat });
    const r = result.report;
    assert.equal(r.severity.level, "Medium");
    assert.equal(r.likely_cause.confidence, "Low");
    assert.deepEqual(r.troubleshooting_steps, [{ step: "restart it", why: "" }]);
    assert.equal(typeof toMarkdown(result), "string");
  });

  test("rejects empty and unstructured input", async () => {
    await assert.rejects(analyze("   "), InputError);
    await assert.rejects(analyze("hello world\nnothing to see"), InputError);
  });
});
