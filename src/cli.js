#!/usr/bin/env node
/** Command-line usage:  node src/cli.js path/to/file.log [--no-ai] [--json]   ('-' reads stdin) */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { analyze, toMarkdown } from "./pipeline.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "no-ai": { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});

if (values.help || positionals.length !== 1) {
  console.error("Usage: node src/cli.js <file|-> [--no-ai] [--json]");
  process.exit(values.help ? 0 : 2);
}

const text = readFileSync(positionals[0] === "-" ? 0 : positionals[0], "utf8");
try {
  const result = await analyze(text, { useLlm: !values["no-ai"] });
  if (result.report.note) console.error(`NOTE: ${result.report.note}\n`);
  console.log(values.json ? JSON.stringify(result, null, 2) : toMarkdown(result));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
