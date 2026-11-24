// Decide runs: node evaluator/src/cli.ts <input.json> <decision.json>. Exit 0 always writes a decision; AUTO or MANUAL is in the file. Any failure to read or write is MANUAL (exit 2).
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate, type Decision } from "./evaluate.ts";

const [inputPath, outputPath] = process.argv.slice(2);
let decision: Decision;
try {
  if (inputPath === undefined || outputPath === undefined) throw new Error("usage: cli.ts <input.json> <decision.json>");
  decision = evaluate(JSON.parse(readFileSync(inputPath, "utf8")) as unknown);
} catch (error) {
  decision = { verdict: "MANUAL", reasons: [{ rule: "input", code: "unreadable-input", message: error instanceof Error ? error.message : "unreadable input" }], alerts: [], rows: [], pipeline: null, sha: null, policyHash: null, inputHash: "" };
}
try {
  if (outputPath !== undefined) writeFileSync(outputPath, `${JSON.stringify(decision, null, 2)}\n`);
} catch {
  process.stdout.write("MANUAL (could not write the decision)\n");
  process.exit(2);
}
process.stdout.write(`${decision.verdict}\n`);
