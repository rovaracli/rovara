// Splits packages/broker/src/aws/developer-tasks.ts and developer-routes.ts into feature modules (see scripts/split/developer-config.ts for the groups).
// A pure move: statements keep their text and order; the original files become thin composition files that re-export what they exported before.
//   node scripts/split/split-developer.ts [--root <checkout>] [--only tasks|routes] [--dry-run] [--manifest <file.json>] [--force] [--allow-placement]
//                                         [--config <module.ts>]
// --dry-run   reports what would move and what cannot be placed, and writes nothing (use it on another checkout, e.g. a public mainline worktree).
// --manifest  writes every declaration name to the file it lands in (scripts/split/rewrite-owner-rows.ts and compare-manifests.ts read it).
// --config    a module exporting CONFIGS (and nothing else is merged); the default is developer-config.ts plus developer-config.private.ts when that file exists.
// Every declaration must be listed in the config (a strict config); --allow-placement reports unlisted names and places them by use instead.
// Both files are planned first and written only if neither has an error: a refusal writes nothing at all.
// The output directory is never touched when it already exists, unless --force: a tree that is already split says so, and a tree whose thin file has gained
// declarations is refused (move them into a module by hand, or regenerate from the unsplit files: remove the directory first). Node runs this directly: erasable syntax only.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { alreadySplit, mergeConfig, planSplit, staleModules, writePlan, type ConfigOverlay, type Plan, type SplitConfig } from "./split-lib.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const root = path.resolve(flag("--root") ?? ".");
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const only = flag("--only");
const manifestPath = flag("--manifest");
const verbose = args.includes("--graph");

const CONFIGS = await loadConfigs(flag("--config"));
const selected = Object.entries(CONFIGS).filter(([name]) => only === undefined || name === only);
if (selected.length === 0) throw new Error(`--only must be one of ${Object.keys(CONFIGS).join(", ")}`);

let failed = false;
const manifest: Record<string, Record<string, string>> = {};
const toWrite: Plan[] = [];
for (const [name, config] of selected) {
  console.log(`\n== ${name}: ${config.source} (${root})`);
  if (!existsSync(path.join(root, config.source))) { console.log("  source file not found"); failed = true; continue; }
  const plan = planSplit(root, config, { allowPlacement: args.includes("--allow-placement") });
  const exists = existsSync(path.join(root, config.outDir));
  if (exists && alreadySplit(root, config, plan)) { console.log("  already split: nothing left to move"); continue; }
  if (exists && !force) {
    const left = plan.units.flatMap((unit, index) => (plan.moduleOf[index] === "" ? [] : [unit.names.join("/")]));
    console.log(`  REFUSED: ${config.outDir}/ already exists and ${left.length} declarations are still in ${path.basename(config.source)} (${left.slice(0, 8).join(", ")}${left.length > 8 ? ", ..." : ""}).`);
    console.log("  Regenerating would overwrite the modules. Move them into a module by hand, or remove the directory and restore the unsplit file first, or pass --force.");
    failed = true;
    continue;
  }
  report(plan);
  const stale = staleModules(root, plan);
  if (stale.length > 0) console.log(`  WARNING: module files this plan does not write (left over?): ${stale.join(", ")}`);
  if (plan.problems.some((problem) => problem.severity === "error")) failed = true;
  manifest[name] = Object.fromEntries(plan.units.flatMap((unit, index) => unit.names.map((symbol) => [symbol, plan.moduleOf[index] === "" ? config.source : `${config.outDir}/${plan.moduleOf[index]}.ts`] as const)));
  toWrite.push(plan);
}
if (manifestPath !== undefined) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (failed) { console.log("\nsplit refused: fix the errors above; nothing was written"); process.exit(1); }
if (!dryRun) {
  for (const plan of toWrite) {
    writePlan(root, plan, { force });
    console.log(`  wrote ${plan.outputs.size} files for ${plan.config.source}`);
  }
}
console.log(dryRun ? "\ndry run: nothing written" : "\ndone");

/** The shared config, with the private overlay merged in when the checkout has one (the overlay file is kept out of the public repository). */
async function loadConfigs(configPath: string | undefined): Promise<Record<string, SplitConfig>> {
  if (configPath !== undefined) return ((await import(pathToFileURL(path.resolve(configPath)).href)) as { CONFIGS: Record<string, SplitConfig> }).CONFIGS;
  const { CONFIGS: shared } = (await import("./developer-config.ts")) as { CONFIGS: Record<string, SplitConfig> };
  const overlayFile = new URL("./developer-config.private.ts", import.meta.url);
  if (!existsSync(overlayFile)) return shared;
  const { OVERLAYS } = (await import(overlayFile.href)) as { OVERLAYS: Record<string, ConfigOverlay> };
  return Object.fromEntries(Object.entries(shared).map(([name, config]) => [name, mergeConfig(config, OVERLAYS[name])]));
}

function report(plan: Plan): void {
  const byModule = new Map<string, number[]>();
  plan.units.forEach((_, index) => byModule.set(plan.moduleOf[index] as string, [...(byModule.get(plan.moduleOf[index] as string) ?? []), index]));
  console.log(`  ${plan.units.length} declarations in ${plan.fileLines} lines`);
  for (const [file, lines] of [...plan.lineCounts].sort()) {
    const module = file === plan.config.source ? "" : path.basename(file, ".ts");
    const members = byModule.get(module) ?? [];
    console.log(`  ${String(lines).padStart(5)} lines  ${file}  (${members.length} declarations moved or kept)`);
  }
  if (plan.missing.length > 0) console.log(`  in the config but not in the file (${plan.missing.length}): ${plan.missing.join(", ")}`);
  if (plan.placedByAffinity.length > 0) {
    console.log(`  not listed, placed by use (${plan.placedByAffinity.length}):`);
    for (const placed of plan.placedByAffinity) console.log(`    ${(plan.units[placed.unit]?.names ?? []).join("/")} -> ${placed.module} (${placed.why})`);
  }
  if (verbose) {
    for (const [from, targets] of [...plan.witnesses].sort()) {
      for (const [to, uses] of [...targets].sort()) console.log(`  edge ${from || "(original)"} -> ${to || "(original)"}: ${uses.slice(0, 6).join(", ")}${uses.length > 6 ? `, +${uses.length - 6}` : ""}`);
    }
  }
  for (const problem of plan.problems) console.log(`  ${problem.severity.toUpperCase()}: ${problem.message}`);
}
