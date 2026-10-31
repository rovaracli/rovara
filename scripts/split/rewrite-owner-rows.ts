// tests/contract/task-owner-reads.test.ts keys each row by the file that holds the function ("aws/developer-tasks.ts"). After a split the function is in
// a new module, so each row's file is rewritten from the manifest that split-developer.ts wrote (declaration name to file). Nothing else in the test changes.
//   node scripts/split/rewrite-owner-rows.ts --manifest <manifest.json> [--root <checkout>]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const root = path.resolve(flag("--root") ?? ".");
const manifestPath = flag("--manifest");
if (manifestPath === undefined) throw new Error("usage: node scripts/split/rewrite-owner-rows.ts --manifest <manifest.json> [--root <checkout>]");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string>>;
const testFile = path.join(root, "tests/contract/task-owner-reads.test.ts");
const original = readFileSync(testFile, "utf8");
const SRC = "packages/broker/src/";
let rewritten = 0;
const missing: string[] = [];
const next = original.replace(/\["(aws\/developer-(?:tasks|routes)\.ts)", "([A-Za-z0-9_$]+)/g, (match, file: string, name: string) => {
  const target = Object.values(manifest).map((names) => names[name]).find((value): value is string => value !== undefined && value.startsWith(`${SRC}${file.replace(/\.ts$/, "")}/`));
  if (target === undefined) { missing.push(`${file} ${name}`); return match; }
  rewritten += 1;
  return `["${target.slice(SRC.length)}", "${name}`;
});
if (missing.length > 0) {
  console.log(`no new home found for: ${missing.join(", ")}; the test file was not changed`);
  process.exit(1);
}
writeFileSync(testFile, next);
console.log(`rewrote ${rewritten} rows`);
