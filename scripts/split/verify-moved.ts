// Proves the split moved text and changed none: every top-level declaration of the original broker.ts must appear, character for character (a leading `export ` aside), in exactly
// the file the split gave it, and the files hold nothing else but imports, re-exports and the module headers.
//
//   node scripts/split/verify-moved.ts <original broker.ts> [--root <checkout>]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { KEEP, readPlan } from "./split-broker.ts";
import config from "./split-broker.config.ts";

const original = process.argv[2];
if (original === undefined) { process.stderr.write("usage: verify-moved.ts <original broker.ts> [--root dir]\n"); process.exit(2); }
const rootIndex = process.argv.indexOf("--root");
const root = path.resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] ?? "." : ".");
const plan = readPlan(path.resolve(original), config);
const strip = (text: string): string => text.replace(/^export\s+/, "");
let missing = 0;
const claimed = new Map<string, string>();
for (const decl of plan.decls) {
  const file = decl.module === KEEP ? config.source : `${config.outDir}/${decl.module}.ts`;
  const content = claimed.get(file) ?? readFileSync(path.join(root, file), "utf8");
  claimed.set(file, content);
  const body = plan.text.slice(decl.nodeStart, decl.spanEnd);
  const before = plan.text.slice(decl.spanStart, decl.nodeStart);
  const exact = content.includes(before + body);
  const exported = content.includes(`${before}export ${strip(body)}`);
  if (!exact && !exported) { missing += 1; process.stdout.write(`MISSING or changed: ${decl.names.join(",")} (${file})\n`); }
}
// Nothing extra: remove every declaration's text from its file, what is left must be imports, re-exports, comments and blank lines.
let stray = 0;
for (const [file, content] of claimed) {
  let rest = content;
  for (const decl of plan.decls) {
    const target = decl.module === KEEP ? config.source : `${config.outDir}/${decl.module}.ts`;
    if (target !== file) continue;
    const body = plan.text.slice(decl.nodeStart, decl.spanEnd);
    const before = plan.text.slice(decl.spanStart, decl.nodeStart);
    rest = rest.replace(`${before}export ${strip(body)}`, "").replace(before + body, "");
  }
  const leftovers = rest.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("import ") && !line.startsWith("export {") && !line.startsWith("export type {") && !line.startsWith("//") && !line.startsWith(" *") && !line.startsWith("/**") && !line.startsWith(" */"));
  if (leftovers.length > 0) { stray += leftovers.length; process.stdout.write(`UNEXPECTED text in ${file}: ${leftovers.slice(0, 3).join(" | ")}\n`); }
}
const files = readdirSync(path.join(root, config.outDir)).length;
process.stdout.write(`${String(plan.decls.length)} declarations checked in ${String(files)} module files + ${config.source}: ${String(missing)} missing or changed, ${String(stray)} unexpected lines\n`);
process.exitCode = missing + stray === 0 ? 0 : 1;
