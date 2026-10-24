/** End-to-end analysis: parse -> rule baseline -> LLM -> validate -> ground-check. */

import * as llm from "./llm.js";
import { extractEvidence, selectExcerpt } from "./parser.js";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { SEVERITIES, baselineSeverity, fallbackReport } from "./rules.js";

export const MAX_LOG_CHARS = 2_000_000;
const WORD_RE = /[A-Za-z][A-Za-z0-9_.\-]{3,}/g;
const STOPWORDS = new Set(["error", "errors", "with", "from", "that", "this", "were", "have", "logs",
  "log", "line", "lines", "times", "repeated", "service", "services", "failed", "failure", "failures",
  "during", "after", "before", "multiple", "shows", "seen"]);

const pickKeys = (o, keys) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));

/** Trim evidence to what the model needs, keeping the prompt small for a local model. */
function factsForPrompt(ev) {
  const keep = Object.fromEntries(["parsed_entries", "levels", "error_count", "warning_count",
    "error_ratio", "time_range", "categories", "http_status", "business_keywords", "first_error",
    "peak_error_minute", "recovery_signals"].map((k) => [k, ev[k]]));
  keep.rule_based_baseline_severity = baselineSeverity(ev);
  keep.services = Object.fromEntries(Object.entries(ev.services).slice(0, 10));
  keep.top_error_signatures = ev.top_signatures.slice(0, 10).map((s) => pickKeys(s,
    ["signature", "level", "count", "services", "first_seen", "last_seen", "root_exception"]));
  // Chronological order of first appearance helps the model separate the
  // trigger from knock-on symptoms.
  keep.sequence_of_first_occurrence = [...ev.top_signatures]
    .sort((a, b) => (a.first_seen ?? "").localeCompare(b.first_seen ?? ""))
    .slice(0, 12)
    .map((s) => `${s.first_seen} ${s.level} [${s.services.join(", ")}] ${s.signature.slice(0, 140)} (x${s.count})`);
  return JSON.stringify(keep, null, 1);
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const capitalize = (s) => { const t = String(s ?? ""); return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); };

/** Coerce the model output into the expected shape so the UI never breaks. */
export function normalizeReport(raw) {
  const r = isObj(raw) ? raw : {};
  const cause = isObj(r.likely_cause) ? r.likely_cause : {};
  const sev = isObj(r.severity) ? r.severity : {};
  const esc = isObj(r.escalation) ? r.escalation : {};
  const level = capitalize(sev.level);
  const confidence = capitalize(cause.confidence ?? "Low");
  return {
    key_errors: asList(r.key_errors).filter(isObj),
    patterns: asList(r.patterns).map(String),
    likely_cause: {
      hypothesis: String(cause.hypothesis ?? "Not determined"),
      confidence: ["High", "Medium", "Low"].includes(confidence) ? confidence : "Low",
      evidence: asList(cause.evidence).map(String),
      assumptions: asList(cause.assumptions).map(String),
    },
    contributing_factors: asList(r.contributing_factors).map(String),
    impact: String(r.impact ?? ""),
    severity: { level: SEVERITIES.includes(level) ? level : "Medium", reason: String(sev.reason ?? "") },
    troubleshooting_steps: asList(r.troubleshooting_steps).map((s) => (isObj(s) ? s : { step: String(s), why: "" })),
    escalation: { required: Boolean(esc.required), to: String(esc.to ?? ""), when: String(esc.when ?? "") },
    incident_summary: String(r.incident_summary ?? ""),
  };
}

/**
 * True if most distinctive words in a claim actually appear in the logs.
 * A cheap hallucination check: it does not prove a claim is correct, but it
 * flags errors/evidence that mention things absent from the logs.
 */
export function grounded(claim, logLower) {
  const words = new Set((String(claim).match(WORD_RE) || [])
    .map((w) => w.toLowerCase().replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((w) => !STOPWORDS.has(w)));
  if (!words.size) return true;
  let hits = 0;
  for (const w of words) if (logLower.includes(w)) hits++;
  return hits / words.size >= 0.5;
}

function groundCheck(report, text) {
  const logLower = text.toLowerCase();
  for (const e of report.key_errors) e.grounded = grounded(e.error ?? "", logLower);
  const cause = report.likely_cause;
  cause.evidence_checks = cause.evidence.map((x) => grounded(x, logLower));
  const checked = report.key_errors.length + cause.evidence.length;
  const ok = report.key_errors.filter((e) => e.grounded).length + cause.evidence_checks.filter(Boolean).length;
  return { checked, grounded: ok };
}

export class InputError extends Error {}

/** `chat` is injectable so tests can simulate model output or an Ollama outage. */
export async function analyze(text, { useLlm = true, chat = llm.chatJson } = {}) {
  if (!text || !text.trim()) throw new InputError("No log content provided.");
  text = text.slice(0, MAX_LOG_CHARS);
  const started = Date.now();

  const ev = extractEvidence(text);
  if (ev.parsed_entries === 0) {
    throw new InputError("No recognisable log lines found. Expected lines with a timestamp "
      + "and/or level (INFO/WARN/ERROR/FATAL), or JSON log lines.");
  }
  const base = baselineSeverity(ev);

  let report;
  let meta = {};
  if (useLlm) {
    try {
      const res = await chat(SYSTEM_PROMPT, buildUserPrompt(factsForPrompt(ev), selectExcerpt(text)), OUTPUT_SCHEMA);
      meta = res.meta;
      report = { ...normalizeReport(res.data), source: "llm", note: null };
    } catch (e) {
      if (!(e instanceof llm.LLMError)) throw e;
      report = fallbackReport(ev, `AI analysis unavailable (${e.message}). Showing rule-based analysis.`);
    }
  } else {
    report = fallbackReport(ev, "Rule-based analysis only (AI disabled).");
  }

  const grounding = groundCheck(report, text);
  return {
    report,
    baseline: { level: base.level, reasons: base.reasons,
      disagrees_with_ai: report.source === "llm" && report.severity.level !== base.level },
    grounding,
    evidence: ev,
    meta: { ...meta, source: report.source, elapsed_s: Math.round((Date.now() - started) / 100) / 10 },
  };
}

/** Shareable incident summary for Slack/Teams/email. */
export function toMarkdown(result) {
  const { report: r, evidence: ev, baseline: b } = result;
  const lc = r.likely_cause;
  const esc = r.escalation;
  const tr = ev.time_range;
  const lines = [
    `## Incident Summary — Severity: ${r.severity.level}`,
    "",
    r.incident_summary,
    "",
    `**Window:** ${tr.start ?? "n/a"} → ${tr.end ?? "n/a"}  `,
    `**Errors:** ${ev.error_count} / ${ev.parsed_entries} entries (${Math.round(ev.error_ratio * 100)}%) · `
      + `**Services:** ${Object.keys(ev.services).slice(0, 6).join(", ")}`,
    "",
    `**Severity reason:** ${r.severity.reason}`,
  ];
  if (b.disagrees_with_ai) lines.push(`_Rule-based baseline rated this **${b.level}** — review before acting._`);
  lines.push("", "### Key errors",
    ...r.key_errors.slice(0, 6).map((e) => `- ${e.error} (×${e.count}, ${(e.services || []).join(", ")})`));
  lines.push("", `### Likely cause (hypothesis, confidence: ${lc.confidence})`, lc.hypothesis,
    "", "**Evidence (from logs):**",
    ...(lc.evidence.length ? lc.evidence.map((x) => `- ${x}`) : ["- none cited"]),
    "", "**Assumptions (not confirmed):**",
    ...(lc.assumptions.length ? lc.assumptions.map((x) => `- ${x}`) : ["- none stated"]));
  if (r.impact) lines.push("", `**Impact:** ${r.impact}`);
  lines.push("", "### Next steps", ...r.troubleshooting_steps.map((s, i) => `${i + 1}. ${s.step}`));
  lines.push("", `**Escalation:** ${esc.required ? "Yes" : "Not yet"} — ${esc.to}. ${esc.when}`);
  lines.push("", `_Generated by Incident Analyzer (${result.meta.model || "rule engine"})._`);
  return lines.join("\n");
}
