/**
 * Deterministic log parsing.
 *
 * Turns raw log text into structured facts (levels, services, repeated error
 * signatures, timeline, keyword categories). These facts are the *evidence*
 * that both the rule engine and the LLM work from, so the AI never has to
 * count or guess numbers on its own.
 */

const TS = String.raw`(?<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)`;
const LEVEL = String.raw`(?<level>TRACE|DEBUG|INFO|NOTICE|WARNING|WARN|ERROR|ERR|SEVERE|CRITICAL|CRIT|FATAL|ALERT|EMERG)`;
const LINE_RE = new RegExp(
  String.raw`^\s*\[?${TS}\]?\s+\[?${LEVEL}\]?\s*(?:\[(?<svc>[^\]]+)\])?\s*[:\-]?\s*(?<msg>.*)$`, "i");
const LEVEL_ONLY_RE = new RegExp(String.raw`\b${LEVEL}\b`, "i");
const SERVICE_KV_RE = /\b(?:service|svc|app|component)=([\w.\-]+)/i;
const CONTINUATION_RE = /^(\s+|Traceback|Caused by:|\.\.\. \d+ more)/;
const HTTP_STATUS_RE = /\b(?:status|code|HTTP\/\d\.\d"?)[=: ]+([1-5]\d\d)\b/gi;

const LEVEL_ALIASES = {
  WARNING: "WARN", ERR: "ERROR", SEVERE: "ERROR",
  CRIT: "CRITICAL", ALERT: "CRITICAL", EMERG: "FATAL", NOTICE: "INFO",
};
export const ERROR_LEVELS = new Set(["ERROR", "CRITICAL", "FATAL"]);

// Keyword categories used for pattern detection and rule-based hints.
const CATEGORIES = {
  timeout: String.raw`time[d ]?out|timed out|deadline exceeded`,
  db_connection: String.raw`connection pool|(?:acquire|obtain|get) (?:jdbc )?connection|jdbc|hikari|` +
    String.raw`sqlexception|deadlock|too many connections|connection slots|` +
    String.raw`(?:database|\bdb\b)\W{1,3}(?:down|unavailable|unreachable)`,
  connection_refused: String.raw`connection refused|econnrefused|connection reset|broken pipe`,
  memory: String.raw`outofmemory|out of memory|\boom\b|heap space|gc overhead|memory limit`,
  disk: String.raw`no space left|disk full|disk usage|inode`,
  auth: String.raw`unauthori[sz]ed|forbidden|authentication fail|invalid token|token expired|\b401\b|\b403\b`,
  upstream_5xx: String.raw`\b50[234]\b|bad gateway|service unavailable|gateway timeout|upstream`,
  crash: String.raw`fatal|panic|segfault|crashloop|crash|exited with code|killed|restarting`,
  rate_limit: String.raw`\b429\b|rate limit|throttl`,
  tls: String.raw`certificate|ssl|tls handshake|x509`,
  circuit_breaker: String.raw`circuit breaker|circuit is open|fallback`,
};
const CATEGORY_RES = Object.fromEntries(
  Object.entries(CATEGORIES).map(([k, v]) => [k, new RegExp(v, "i")]));

const RECOVERY_RE = /succeeded|recovered|reconnected|restored|started \w+ in|healthy|status=up|back to normal/i;
const BUSINESS_CRITICAL_RE = /payment|checkout|order|transaction|billing|login|auth-service|settlement/gi;

const NORMALIZERS = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<ID>"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<IP>"],
  [/\b0x[0-9a-f]+\b/gi, "<HEX>"],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{10,}\b/gi, "<ID>"],
  [/(['"]).*?\1/g, "<STR>"],
  [/\b[A-Z]{2,5}-?\d{3,}\b/g, "<ID>"],
  [/\b\d+(?:\.\d+)?(?:ms|s|m|h|%|kb|mb|gb)?\b/gi, "<N>"],
];

/** Collapse variable parts (ids, numbers, IPs) so similar errors group together. */
export function normalize(message) {
  let sig = message;
  for (const [pattern, repl] of NORMALIZERS) sig = sig.replace(pattern, repl);
  return sig.replace(/\s+/g, " ").trim().slice(0, 180);
}

/** Parse a timestamp to epoch ms. Timestamps without a zone are treated as UTC. */
function parseTs(value) {
  if (!value) return null;
  let v = value.replace(",", ".").replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v)) v += "Z";
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 19).replace("T", " "));

function parseJsonLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const pick = (...keys) => {
    const k = keys.find((key) => obj[key] != null);
    return k === undefined ? null : String(obj[k]);
  };
  return {
    ts: pick("timestamp", "time", "ts", "@timestamp"),
    level: pick("level", "severity", "lvl"),
    service: pick("service", "app", "logger", "component"),
    message: pick("message", "msg", "error") ?? line,
  };
}

/** Return an object for a log line, or null if the line has no recognisable structure. */
export function parseLine(line) {
  if (line.trimStart().startsWith("{")) {
    const parsed = parseJsonLine(line.trim());
    if (parsed) return parsed;
  }
  let m = LINE_RE.exec(line);
  if (m) {
    const { ts, level, svc, msg } = m.groups;
    return { ts, level, service: svc ?? SERVICE_KV_RE.exec(msg)?.[1] ?? null, message: msg };
  }
  m = LEVEL_ONLY_RE.exec(line);
  if (m) {
    return { ts: null, level: m.groups.level, service: SERVICE_KV_RE.exec(line)?.[1] ?? null,
             message: line.trim() };
  }
  return null;
}

function canonicalLevel(level) {
  const l = (level || "INFO").toUpperCase();
  return LEVEL_ALIASES[l] ?? l;
}

/** Parse raw log text into entries, attaching stack-trace lines to their parent entry. */
export function parseLogs(text) {
  const entries = [];
  let unparsed = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (entries.length && CONTINUATION_RE.test(raw) && !LINE_RE.test(raw)) {
      entries.at(-1).trace.push(raw.trim());
      continue;
    }
    const parsed = parseLine(raw);
    if (!parsed) { unparsed++; continue; }
    entries.push({
      timestamp: parseTs(parsed.ts),
      level: canonicalLevel(parsed.level),
      service: (parsed.service || "unknown").trim(),
      message: parsed.message.trim(),
      raw: raw.trimEnd(),
      trace: [],
    });
  }
  return { entries, unparsed };
}

const inc = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };
const sortedDesc = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

/** Build the structured evidence summary for a block of log text. */
export function extractEvidence(text) {
  const { entries, unparsed } = parseLogs(text);
  const levels = {};
  const services = {};
  const signatures = new Map();
  const categories = {};
  const categoryExamples = {};
  const httpStatus = {};
  const perMinute = {};
  const businessHits = {};
  const recoveries = [];

  for (const e of entries) {
    inc(levels, e.level);
    const svc = (services[e.service] ??= { total: 0, errors: 0, warnings: 0 });
    svc.total++;
    const isError = ERROR_LEVELS.has(e.level);
    const isWarn = e.level === "WARN";
    if (isError) svc.errors++;
    if (isWarn) svc.warnings++;

    const fullText = [e.message, ...e.trace].join(" ");
    for (const m of fullText.matchAll(HTTP_STATUS_RE)) inc(httpStatus, m[1]);

    if (!isError && !isWarn) {
      if (RECOVERY_RE.test(e.message)) recoveries.push(e.raw.slice(0, 200));
      continue;
    }

    for (const [cat, cre] of Object.entries(CATEGORY_RES)) {
      if (cre.test(fullText)) {
        inc(categories, cat);
        categoryExamples[cat] ??= e.raw.slice(0, 240);
      }
    }
    for (const m of `${fullText} ${e.service}`.matchAll(BUSINESS_CRITICAL_RE)) {
      inc(businessHits, m[0].toLowerCase());
    }
    if (isError && e.timestamp != null) inc(perMinute, iso(e.timestamp).slice(0, 16));

    const level = isError ? e.level : "WARN";
    const signature = normalize(e.message);
    const key = `${level}\u0000${signature}`;
    let sig = signatures.get(key);
    if (!sig) {
      sig = { signature, level, count: 0, services: new Set(), first_seen: e.timestamp,
              last_seen: e.timestamp, example: e.raw.slice(0, 300), root_exception: null };
      signatures.set(key, sig);
    }
    sig.count++;
    sig.services.add(e.service);
    if (e.timestamp != null) {
      sig.first_seen = sig.first_seen == null ? e.timestamp : Math.min(sig.first_seen, e.timestamp);
      sig.last_seen = sig.last_seen == null ? e.timestamp : Math.max(sig.last_seen, e.timestamp);
    }
    const causedBy = e.trace.filter((t) => t.startsWith("Caused by:"));
    if (causedBy.length) sig.root_exception = causedBy.at(-1).slice(0, 240);
  }

  const sigOut = (s) => ({ ...s, services: [...s.services].sort(),
                           first_seen: iso(s.first_seen), last_seen: iso(s.last_seen) });
  // Errors before warnings, then by frequency (stable sort keeps first-seen order on ties).
  const ordered = [...signatures.values()].sort(
    (a, b) => (a.level === "WARN") - (b.level === "WARN") || b.count - a.count);

  const timestamps = entries.map((e) => e.timestamp).filter((t) => t != null);
  const start = timestamps.length ? Math.min(...timestamps) : null;
  const end = timestamps.length ? Math.max(...timestamps) : null;
  const errorCount = [...ERROR_LEVELS].reduce((n, l) => n + (levels[l] ?? 0), 0);
  const firstError = entries.find((e) => ERROR_LEVELS.has(e.level));
  const peak = Object.entries(perMinute).reduce((best, kv) => (!best || kv[1] > best[1] ? kv : best), null);

  return {
    total_lines: text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0),
    parsed_entries: entries.length,
    unparsed_lines: unparsed,
    levels,
    error_count: errorCount,
    warning_count: levels.WARN ?? 0,
    error_ratio: entries.length ? Math.round((errorCount / entries.length) * 1000) / 1000 : 0,
    time_range: {
      start: iso(start), end: iso(end),
      duration_seconds: start != null ? Math.round((end - start) / 1000) : null,
    },
    services: Object.fromEntries(Object.entries(services).sort((a, b) => b[1].errors - a[1].errors)),
    top_signatures: ordered.slice(0, 12).map(sigOut),
    repeated_failures: ordered.filter((s) => s.count >= 3 && s.level !== "WARN").map(sigOut),
    categories: sortedDesc(categories),
    category_examples: categoryExamples,
    http_status: sortedDesc(httpStatus),
    business_keywords: sortedDesc(businessHits),
    first_error: firstError ? firstError.raw.slice(0, 300) : null,
    recovery_signals: { count: recoveries.length, examples: recoveries.slice(0, 3) },
    errors_per_minute: Object.fromEntries(Object.entries(perMinute).sort()),
    peak_error_minute: peak ? { minute: peak[0], errors: peak[1] } : null,
  };
}

/**
 * Pick the most informative lines for the LLM: errors/warnings first, plus context.
 * Keeps original order, includes the first lines (startup context) and the first
 * stack-trace lines of each error, and stays within maxChars.
 */
export function selectExcerpt(text, maxChars = 6000) {
  const lines = text.split(/\r?\n/);
  const keep = new Set([...Array(Math.min(5, lines.length)).keys()]);
  lines.forEach((line, i) => {
    const parsed = parseLine(line);
    const level = parsed ? canonicalLevel(parsed.level) : null;
    if (ERROR_LEVELS.has(level) || level === "WARN") {
      keep.add(i);
      for (let j = i + 1; j < lines.length && j <= i + 3 && CONTINUATION_RE.test(lines[j]); j++) keep.add(j);
    }
  });

  const out = [];
  const seen = {};
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i].slice(0, 400);
    // Collapse long runs of identical errors so the excerpt shows variety.
    const sig = normalize(line);
    inc(seen, sig);
    if (seen[sig] > 4) continue;
    if (size + line.length + 1 > maxChars) {
      out.push(`... [excerpt truncated; ${lines.length} total lines] ...`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}
