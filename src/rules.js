/**
 * Rule-based triage.
 *
 * Two jobs:
 * 1. A transparent baseline severity, computed only from parsed evidence. The UI
 *    shows it next to the AI's severity so a disagreement is visible, not hidden.
 * 2. A complete fallback report when the local LLM is unavailable, so the tool
 *    still produces a useful (if less nuanced) analysis.
 */

export const SEVERITIES = ["Critical", "High", "Medium", "Low"];

// Resource/config failures usually *cause* the symptom categories (timeouts,
// 5xx, open circuits), so they are preferred when picking a likely cause.
const ROOT_CAUSE_ORDER = ["memory", "disk", "db_connection", "tls", "auth", "rate_limit",
  "connection_refused", "crash", "timeout", "upstream_5xx", "circuit_breaker"];

const PLAYBOOK = {
  db_connection: {
    cause: "Database connectivity problems (connection pool exhaustion, slow queries or DB unavailability).",
    steps: [
      ["Check database health, CPU and active connection count against the pool/max_connections limit.",
        "Pool exhaustion and DB saturation both produce 'could not acquire connection' errors."],
      ["Look for long-running or blocked queries and recent schema/index changes.",
        "Slow queries hold connections longer and drain the pool."],
    ],
    escalate: "Database / DBA on-call",
  },
  timeout: {
    cause: "Requests timing out on a slow or unresponsive dependency.",
    steps: [
      ["Identify which downstream call times out first and check its latency dashboards.",
        "The earliest timeout usually points to the originating bottleneck."],
      ["Compare configured timeouts and retry settings with current dependency latency.",
        "Aggressive retries can amplify load on a struggling dependency."],
    ],
    escalate: "Owning team of the slow dependency",
  },
  connection_refused: {
    cause: "A dependency is refusing or dropping connections (down, restarting, or wrong host/port).",
    steps: [["Verify the target host/port is up and reachable from the affected service.",
      "Connection refused means nothing is listening, or a firewall rejects the call."]],
    escalate: "Platform / network team",
  },
  memory: {
    cause: "Memory exhaustion in the application process or container.",
    steps: [
      ["Check container memory usage versus limits and recent OOMKilled events.",
        "Confirms whether the process is being killed for exceeding its limit."],
      ["Capture a heap dump or memory profile and review recent deploys for leaks.",
        "Steady memory growth before the crash points to a leak."],
    ],
    escalate: "Application engineering team",
  },
  disk: {
    cause: "Disk space exhaustion on a host or volume.",
    steps: [["Check disk/inode usage and clear or rotate logs and temp files.",
      "Writes fail once the volume is full."]],
    escalate: "Infrastructure / SRE",
  },
  upstream_5xx: {
    cause: "An upstream service or gateway is returning 5xx errors.",
    steps: [["Check the health and recent deploys of the upstream service returning 5xx.",
      "502/503/504 usually originate from the upstream, not the caller."]],
    escalate: "Owning team of the upstream service",
  },
  crash: {
    cause: "The service process is crashing or restarting.",
    steps: [["Check restart counts, exit codes and the logs just before each restart.",
      "The last lines before a crash usually contain the trigger."]],
    escalate: "Application engineering team (on-call)",
  },
  auth: {
    cause: "Authentication/authorization failures (expired or invalid credentials/tokens).",
    steps: [["Check credential/token expiry and recent secret or IAM changes.",
      "Rotated or expired secrets cause sudden 401/403 spikes."]],
    escalate: "Identity / security team",
  },
  rate_limit: {
    cause: "Requests are being throttled by a rate limit.",
    steps: [["Check traffic volume against the provider's rate limits and retry/backoff behaviour.",
      "Retry storms often push callers over rate limits."]],
    escalate: "Owning team of the rate-limited API",
  },
  tls: {
    cause: "TLS/certificate problems (expired certificate or trust-store mismatch).",
    steps: [["Check certificate expiry dates and trust-store configuration on both sides.",
      "Certificate expiry causes sudden handshake failures."]],
    escalate: "Platform / security team",
  },
  circuit_breaker: {
    cause: "Circuit breakers opened because a dependency kept failing.",
    steps: [["Find the dependency behind the open circuit and fix it before forcing the breaker closed.",
      "An open breaker is a symptom of the failing dependency, not the cause."]],
    escalate: "Owning team of the failing dependency",
  },
};

/** Score severity from evidence only. Returns { level, reasons }. */
export function baselineSeverity(ev) {
  const reasons = [];
  const cats = ev.categories;
  const errors = ev.error_count;
  const ratio = ev.error_ratio;
  const fatal = (ev.levels.FATAL ?? 0) + (ev.levels.CRITICAL ?? 0);
  const business = Object.keys(ev.business_keywords);
  const crash = (cats.crash ?? 0) > 0 || fatal > 0;
  const widespread = Object.values(ev.services).filter((s) => s.errors).length >= 3;

  if (fatal) reasons.push(`${fatal} FATAL/CRITICAL log entries`);
  if (cats.crash) reasons.push(`${cats.crash} crash/restart indicators`);
  if (business.length) reasons.push(`errors involve business-critical flows (${business.slice(0, 4).join(", ")})`);
  reasons.push(`${errors} errors out of ${ev.parsed_entries} entries (${Math.round(ratio * 100)}% error rate)`);
  if (widespread) reasons.push("errors spread across 3+ services");
  if (ev.repeated_failures.length) reasons.push(`${ev.repeated_failures.length} error types repeat 3+ times`);

  let level;
  if (crash && (business.length || ratio >= 0.3 || widespread)) level = "Critical";
  else if (crash || (errors >= 10 && (business.length || ratio >= 0.3)) || (business.length && errors >= 5)) level = "High";
  else if (errors >= 3 || ev.warning_count >= 10) level = "Medium";
  else level = "Low";
  return { level, reasons };
}

/** Rule-only analysis in the same shape as the LLM report. */
export function fallbackReport(ev, note) {
  const { level, reasons } = baselineSeverity(ev);
  const cats = Object.keys(ev.categories).filter((c) => PLAYBOOK[c])
    .sort((a, b) => ROOT_CAUSE_ORDER.indexOf(a) - ROOT_CAUSE_ORDER.indexOf(b));
  const top = ev.top_signatures;

  const keyErrors = top.slice(0, 6).map((s) => ({
    error: s.signature, count: s.count, services: s.services,
    significance: `${s.level} seen ${s.count}x` + (s.first_seen ? ` between ${s.first_seen} and ${s.last_seen}` : ""),
  }));

  const patterns = ev.repeated_failures.slice(0, 5).map(
    (s) => `'${s.signature.slice(0, 90)}' repeated ${s.count} times across ${s.services.join(", ")}`);
  if (ev.peak_error_minute) {
    patterns.push(`Error peak of ${ev.peak_error_minute.errors} errors at ${ev.peak_error_minute.minute}`);
  }

  const primary = cats[0] ?? null;
  const hypothesis = primary ? PLAYBOOK[primary].cause
    : "No known failure pattern matched; manual review of the top errors is needed.";
  const evidence = primary
    ? cats.slice(0, 3).map((c) => `${ev.categories[c]} error/warning lines match '${c}' indicators, e.g. ${ev.category_examples[c].slice(0, 160)}`)
    : top.length ? [`Most frequent error: ${top[0].signature}`] : [];

  const steps = [];
  const escalateTo = [];
  for (const c of cats.slice(0, 3)) {
    steps.push(...PLAYBOOK[c].steps.map(([step, why]) => ({ step, why })));
    escalateTo.push(PLAYBOOK[c].escalate);
  }
  if (ev.first_error) {
    steps.unshift({ step: `Start from the first error in the window: ${ev.first_error.slice(0, 160)}`,
      why: "The earliest error is the most likely trigger; later errors are often knock-on effects." });
  }

  const required = level === "Critical" || level === "High";
  const tr = ev.time_range;
  return {
    source: "rules",
    note,
    key_errors: keyErrors,
    patterns,
    likely_cause: {
      hypothesis,
      confidence: "Low",
      evidence,
      assumptions: ["Cause inferred from keyword matching only; no AI reasoning was applied."],
    },
    contributing_factors: cats.slice(1, 4).map((c) => PLAYBOOK[c].cause),
    impact: Object.keys(ev.business_keywords).length ? "Business-critical flows appear affected."
      : "Impact not determinable from logs alone.",
    severity: { level, reason: reasons.join("; ") },
    troubleshooting_steps: steps.slice(0, 7),
    escalation: {
      required,
      to: [...new Set(escalateTo)].join(", ") || "Service owner",
      when: required ? `Now: severity is ${level}` : "If errors continue to grow or customer impact is confirmed.",
    },
    incident_summary: `[${level}] ${ev.error_count} errors across ${Object.keys(ev.services).length} service(s)`
      + (tr.start ? ` between ${tr.start} and ${tr.end}` : "")
      + `. Likely area: ${primary ?? "unknown"}. ${hypothesis}`,
  };
}
