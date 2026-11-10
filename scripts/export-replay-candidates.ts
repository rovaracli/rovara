// Lessons replay (lane 7): the candidates file that `scripts/lessons-replay-measure.ts select` ranks. READ-ONLY and it makes NO AWS call: its input is a JSON file the operator exports (the same State table items
// as `scripts/export-replay-tasks.ts`), its output one JSON file of { taskId, project, repository, at, memberCorrections, outcome }. See the header of export-replay-tasks.ts for the guarded export commands
// (every staging AWS command through ~/.local/share/rovara-tools/staging-aws.sh).
//
//   npx tsx scripts/export-replay-candidates.ts --input <items.json> --out <candidates.json> [--org <org id>] [--corrections <counts.json>] [--marshalled]
//
// THE INPUT is a JSON array of items or { "items": [...], "corrections": { "<taskId>": { "prComments": n, "humanEdits": n, "reverts": n } } }. The items are the `DEVTASK#<taskId>` / `META` items of the finished tasks
// (with --marshalled they may be DynamoDB JSON). `corrections` is optional: the counts from the Team record for what the task record cannot hold. Without it a task's corrections are its human send-backs only.
// Output on the terminal is counts only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { candidatesFromItems, type ExtraCorrections } from "../packages/broker/src/lessons/replay-candidates.js";

export function main(argv: readonly string[], io: { out(t: string): void; err(t: string): void }): number {
  const values = new Map<string, string>();
  let marshalled = false;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const name = argv[i] ?? "";
      if (name === "--marshalled") { marshalled = true; continue; }
      if (!["--input", "--out", "--org", "--corrections"].includes(name)) throw new Error(`unknown option ${name}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.set(name, value);
      i += 1;
    }
    const inputFile = values.get("--input"), outFile = values.get("--out");
    if (inputFile === undefined || outFile === undefined) throw new Error("--input and --out are required");
    const raw: unknown = JSON.parse(readFileSync(inputFile, "utf8"));
    const body = Array.isArray(raw) ? { items: raw as unknown[] } : (raw as { items: unknown[]; corrections?: Record<string, ExtraCorrections> });
    if (!Array.isArray(body.items)) throw new Error("the input holds no items");
    const items = marshalled ? body.items.map((item) => unmarshall(item as Record<string, never>)) : body.items;
    const extraFile = values.get("--corrections");
    const corrections = extraFile === undefined ? (body as { corrections?: Record<string, ExtraCorrections> }).corrections : JSON.parse(readFileSync(extraFile, "utf8")) as Record<string, ExtraCorrections>;
    const org = values.get("--org");
    const result = candidatesFromItems({ items, ...(corrections === undefined ? {} : { corrections }) }, org === undefined ? {} : { orgId: org });
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(result.candidates, null, 2)}\n`);
    io.out(`${String(result.candidates.length)} candidates; skipped ${Object.entries(result.skipped).filter(([, n]) => n > 0).map(([r, n]) => `${r} ${String(n)}`).join(", ") || "none"}; ${String(result.ignoredItems)} items ignored`);
    return 0;
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) });
}
