// Generate simulated sample logs for demos and tests (deterministic; seed fixed).
// Run:  npm run samples

import { writeFileSync } from "node:fs";

const OUT = new URL(".", import.meta.url);

// mulberry32: small seeded PRNG so samples are reproducible.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const uniform = (a, b) => a + rand() * (b - a);

const pad = (n, w = 2) => String(n).padStart(w, "0");
const ts = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
  + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())},${pad(d.getUTCMilliseconds(), 3)}`;
const addSec = (d, s) => new Date(d.getTime() + Math.round(s * 1000));
const txn = () => `TXN-${randint(100000, 999999)}`;
const ip = () => `${randint(10, 250)}.${randint(1, 250)}.${randint(1, 250)}.${randint(1, 250)}`;

function logger() {
  const out = [];
  return {
    out,
    add: (d, lvl, svc, msg) => out.push(`${ts(d)} ${lvl.padEnd(5)} [${svc}] ${msg}`),
    text: () => out.join("\n") + "\n",
  };
}

/** Payment API timeouts caused by DB connection-pool exhaustion (expected: Critical). */
function paymentDbOutage() {
  let t = new Date(Date.UTC(2026, 9, 22, 14, 0, 0));
  const { out, add, text } = logger();
  for (let i = 0; i < 8; i++) {
    t = addSec(t, uniform(3, 9));
    add(t, "INFO", "payment-service", `POST /api/v1/payments txn=${txn()} status=200 latency=${randint(80, 180)}ms`);
    add(t, "INFO", "order-service", `Order ORD-${randint(10000, 99999)} created, awaiting payment`);
  }
  t = addSec(t, 4);
  add(t, "WARN", "payment-service", "HikariPool-1 - Connection pool usage at 85% (17/20 active)");
  t = addSec(t, 6);
  add(t, "WARN", "payment-db", "Slow query detected: SELECT * FROM transactions WHERE status='PENDING' took 8421ms");
  t = addSec(t, 3);
  add(t, "WARN", "payment-service", "HikariPool-1 - Connection pool usage at 100% (20/20 active), 14 threads waiting");
  for (let i = 0; i < 14; i++) {
    t = addSec(t, uniform(1, 5));
    add(t, "ERROR", "payment-service",
      "Unable to acquire JDBC Connection: HikariPool-1 - Connection is not available, request timed out after 30000ms");
    if (i % 3 === 0) {
      out.push("\tat com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)");
      out.push("\tat com.acme.payments.repo.TransactionRepository.save(TransactionRepository.java:88)");
      out.push("Caused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available");
    }
    t = addSec(t, uniform(0.5, 2));
    add(t, "ERROR", "payment-service",
      `POST /api/v1/payments txn=${txn()} failed: PaymentGatewayTimeoutException: payment processing timed out after 30s status=504`);
    if (i % 2 === 0) {
      add(t, "ERROR", "api-gateway", `upstream payment-service returned 504 Gateway Timeout for POST /api/v1/payments client=${ip()}`);
    }
    if (i % 4 === 1) {
      add(t, "WARN", "order-service", `Order ORD-${randint(10000, 99999)} payment pending > 60s, retrying (attempt ${Math.floor(i / 4) + 2}/3)`);
    }
    if (i === 9) {
      add(t, "ERROR", "payment-db", "FATAL: remaining connection slots are reserved for non-replication superuser connections");
    }
  }
  t = addSec(t, 5);
  add(t, "ERROR", "order-service", "Circuit breaker 'paymentClient' is OPEN - failing fast for 60s");
  for (let i = 0; i < 4; i++) {
    t = addSec(t, uniform(1, 4));
    add(t, "ERROR", "order-service", `Checkout failed for order ORD-${randint(10000, 99999)}: payment service unavailable (circuit open)`);
  }
  t = addSec(t, 3);
  add(t, "INFO", "payment-service", "Health check /actuator/health status=DOWN (db: DOWN)");
  return text();
}

/** Gradual heap growth -> OutOfMemoryError -> container restarts (expected: Critical). */
function checkoutMemoryLeak() {
  let t = new Date(Date.UTC(2026, 9, 21, 9, 30, 0));
  const { out, add, text } = logger();
  let heap = 52;
  for (let i = 0; i < 10; i++) {
    t = addSec(t, 120);
    heap += randint(3, 6);
    add(t, "INFO", "cart-service", `GET /api/cart status=200 latency=${randint(40, 90) + heap}ms`);
    if (heap > 70) add(t, "WARN", "cart-service", `JVM heap usage at ${heap}% after full GC (GC pause ${randint(400, 1800)}ms)`);
  }
  add(t, "WARN", "cart-service", "GC overhead limit approaching: 92% of time spent in GC over last 60s");
  for (let restart = 0; restart < 3; restart++) {
    t = addSec(t, 40);
    add(t, "ERROR", "cart-service", 'Exception in thread "http-nio-8080-exec-17" java.lang.OutOfMemoryError: Java heap space');
    out.push("\tat java.util.Arrays.copyOf(Arrays.java:3512)");
    out.push("\tat com.acme.cart.SessionCartCache.put(SessionCartCache.java:57)");
    add(t, "FATAL", "cart-service", "Application terminated unexpectedly, exited with code 137");
    add(t, "WARN", "kubelet", `Container cart-service-7d9f8 OOMKilled (memory limit 1Gi), restarting (restart count ${restart + 1})`);
    for (let k = 0; k < 3; k++) {
      t = addSec(t, 2);
      add(t, "ERROR", "checkout-service", "GET http://cart-service:8080/api/cart failed: Connection refused");
      add(t, "ERROR", "api-gateway", "upstream cart-service returned 503 Service Unavailable for GET /api/cart");
    }
    t = addSec(t, 25);
    add(t, "INFO", "cart-service", "Started CartApplication in 18.4 seconds");
  }
  add(t, "WARN", "kubelet", "Back-off restarting failed container cart-service-7d9f8 (CrashLoopBackOff)");
  return text();
}

/** Redis latency spikes, intermittent timeouts, fallback to DB (expected: Medium). */
function cacheLatencyDegraded() {
  let t = new Date(Date.UTC(2026, 9, 20, 18, 10, 0));
  const { add, text } = logger();
  for (let i = 0; i < 40; i++) {
    t = addSec(t, uniform(5, 15));
    add(t, "INFO", "catalog-service", `GET /api/products/${randint(1000, 9999)} status=200 latency=${randint(30, 120)}ms`);
    if (i % 6 === 3) add(t, "WARN", "catalog-service", `Redis command GET took ${randint(250, 900)}ms (threshold 200ms) host=10.0.4.21:6379`);
    if ([14, 27, 33].includes(i)) add(t, "ERROR", "catalog-service", "Redis timeout: Command timed out after 1000ms; falling back to database read");
    if (i === 20) add(t, "WARN", "redis-cache", "used_memory 3.6GB of maxmemory 4GB, evicting keys (policy allkeys-lru)");
  }
  return text();
}

/** Routine warnings with one retried call (expected: Low). JSON-lines format. */
function minorWarnings() {
  let t = new Date(Date.UTC(2026, 9, 19, 11, 0, 0));
  const out = [];
  const add = (level, service, message) =>
    out.push(JSON.stringify({ timestamp: t.toISOString().slice(0, 19) + "Z", level, service, message }));
  for (let i = 0; i < 25; i++) {
    t = addSec(t, uniform(10, 40));
    add("INFO", "notification-service", `Email queued for user ${randint(1000, 9999)}`);
    if (i === 4) add("WARN", "notification-service", "Config key 'smtp.legacy_tls' is deprecated and will be removed in v3.0");
    if (i === 11) add("WARN", "notification-service", "SMTP send attempt 1 failed: 421 Service not available, retrying in 5s");
    if (i === 12) add("INFO", "notification-service", "SMTP send attempt 2 succeeded");
    if (i === 18) add("ERROR", "notification-service", "Template 'promo_banner_v2' not found for locale fr-CA, using default template");
  }
  return out.join("\n") + "\n";
}

const files = {
  "payment_db_outage.log": paymentDbOutage(),
  "checkout_memory_leak.log": checkoutMemoryLeak(),
  "cache_latency_degraded.log": cacheLatencyDegraded(),
  "minor_warnings.jsonl": minorWarnings(),
};
for (const [name, content] of Object.entries(files)) {
  writeFileSync(new URL(name, OUT), content);
  console.log(`wrote ${name} (${content.trimEnd().split("\n").length} lines)`);
}
