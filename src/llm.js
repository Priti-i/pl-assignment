/** Minimal Ollama client (Node built-in fetch, no dependencies). */

export const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/+$/, "");
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT || 300) * 1000;

export class LLMError extends Error {}

async function request(path, payload, timeoutMs = 10_000) {
  let resp;
  try {
    resp = await fetch(`${OLLAMA_HOST}${path}`, {
      method: payload ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new LLMError(`Cannot reach Ollama at ${OLLAMA_HOST}: ${e.cause?.code || e.name || e.message}`);
  }
  if (!resp.ok) {
    throw new LLMError(`Ollama returned HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json();
}

/** Report whether Ollama is reachable and the configured model is installed. */
export async function health() {
  let models;
  try {
    models = ((await request("/api/tags")).models || []).map((m) => m.name);
  } catch (e) {
    return { ollama: false, model: OLLAMA_MODEL, model_ready: false, installed: [], error: e.message };
  }
  const ready = models.some((m) => m === OLLAMA_MODEL || m === `${OLLAMA_MODEL}:latest`);
  return {
    ollama: true, model: OLLAMA_MODEL, model_ready: ready, installed: models,
    error: ready ? null : `Model '${OLLAMA_MODEL}' not installed. Run: ollama pull ${OLLAMA_MODEL}`,
  };
}

/** Call Ollama with a JSON schema constraint and return { data, meta }. */
export async function chatJson(system, user, schema) {
  const resp = await request("/api/chat", {
    model: OLLAMA_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    format: schema,
    stream: false,
    // Low temperature: triage should be consistent, not creative.
    options: { temperature: 0.1, num_ctx: 8192 },
  }, TIMEOUT_MS);
  const content = resp.message?.content ?? "";
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new LLMError(`Model returned invalid JSON: ${content.slice(0, 300)}`);
  }
  return {
    data,
    meta: {
      model: resp.model || OLLAMA_MODEL,
      duration_s: Math.round((resp.total_duration || 0) / 1e8) / 10,
      prompt_tokens: resp.prompt_eval_count ?? null,
      output_tokens: resp.eval_count ?? null,
    },
  };
}
