/**
 * Incident Analyzer web server (Node built-ins only).
 *
 * Run:  npm start   (or: node server.js)   then open http://localhost:8000
 * Env:  OLLAMA_MODEL (default qwen2.5:7b), OLLAMA_HOST, PORT
 */

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as llm from "./src/llm.js";
import { InputError, analyze, toMarkdown } from "./src/pipeline.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STATIC = join(ROOT, "static");
const SAMPLES = join(ROOT, "sample_logs");
const SAMPLE_EXTS = new Set([".log", ".jsonl", ".txt"]);
const MAX_BODY = 5 * 1024 * 1024;
const PORT = Number(process.env.PORT || 8000);
// Hosting platforms (Render sets RENDER=true) must reach the app from outside;
// locally, stay on loopback so logs are not exposed on the network.
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");

function send(res, status, body, type = "application/json") {
  const data = Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new InputError(`Log input too large (max ${MAX_BODY / 1024 / 1024} MB).`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

  if (req.method === "GET") {
    if (path === "/" || path === "/index.html") {
      return send(res, 200, await readFile(join(STATIC, "index.html")), "text/html; charset=utf-8");
    }
    if (path === "/api/health") return send(res, 200, await llm.health());
    if (path === "/api/samples") {
      const names = (await readdir(SAMPLES)).filter((n) => SAMPLE_EXTS.has(extname(n))).sort();
      return send(res, 200, { samples: names });
    }
    if (path.startsWith("/api/samples/")) {
      const name = path.slice("/api/samples/".length);
      // Only serve plain files directly inside sample_logs/.
      if (name.includes("/") || name.includes("\\") || name.includes("..") || !SAMPLE_EXTS.has(extname(name))) {
        return send(res, 404, { error: "sample not found" });
      }
      const file = join(SAMPLES, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return send(res, 404, { error: "sample not found" });
      return send(res, 200, await readFile(file), "text/plain; charset=utf-8");
    }
  }

  if (req.method === "POST" && path === "/api/analyze") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      return send(res, e instanceof InputError ? 413 : 400, { error: e instanceof InputError ? e.message : "Invalid JSON body." });
    }
    try {
      const result = await analyze(String(body.logs ?? ""), { useLlm: body.use_llm !== false });
      result.markdown = toMarkdown(result);
      return send(res, 200, result);
    } catch (e) {
      if (e instanceof InputError) return send(res, 400, { error: e.message });
      throw e;
    }
  }

  send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  res.on("finish", () => console.error(`[server] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
  try {
    await handle(req, res);
  } catch (e) {
    // Keep the demo server alive and report the problem.
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: `Analysis failed: ${e.message}` });
  }
});
// Local model calls can take over a minute; don't let Node cut the request off.
server.requestTimeout = 0;

server.listen(PORT, HOST, async () => {
  const h = await llm.health();
  console.log(`Ollama: ${h.ollama ? "reachable" : "NOT reachable"} at ${llm.OLLAMA_HOST} | model ${h.model}: `
    + (h.model_ready ? "ready" : "NOT installed (rule-based fallback will be used)"));
  console.log(`Incident Analyzer running at http://${HOST}:${PORT}`);
});
