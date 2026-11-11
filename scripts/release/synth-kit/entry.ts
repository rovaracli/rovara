// The synthesis kit: the release's own pinned CDK app, run as `node synth.mjs <context.json> <out dir>` by `agentx bundle approve`, inside a sandbox with no network, no credentials and a scrubbed
// environment. It reads the context file (the whole of its input: the install's own settings, written by the approving command), builds the app with them and writes the output tree
// `SynthOutputSchema` describes: one template per stack, the signed zip of every code package those templates ask for, and kit-output.json.
//
// Lambda code is never built here (see prebuilt-code.ts): each function takes the package the release named for it, and this file copies the signed zip from the kit's own code/ folder.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_PARTS, SYNTH_OUTPUT_FILE, SynthOutputSchema, type BuiltPart } from "@agentx/cloud-contracts";
import { environmentStackName } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../../infra/lib/app.js";
import { accumulateAsset, type PackageAccumulator } from "../assets.js";
import { CodeMapSchema, KIT_CODE_MAP_FILE, kitCodeFile } from "./code-map.js";
import { assertNoLookups, checkedContext } from "./kit-checks.js";
import { registerPrebuiltCode } from "./prebuilt-code.js";

/** Runs `run` with the process's output discarded: CDK prints validation notices while it synthesises, and a kit's output is capped. */
function quiet<T>(run: () => T): T {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const discard = ((): boolean => true) as typeof process.stdout.write;
  process.stdout.write = discard;
  process.stderr.write = discard;
  try {
    return run();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function main(): void {
  // CDK's template validation (a developer lint that reads rule files from beside its own source, which a bundle does not have) adds nothing to a template; the release ran it on its own.
  process.env.CDK_VALIDATION = "false";
  const [contextFile, outDir] = process.argv.slice(2);
  if (contextFile === undefined || outDir === undefined) throw new Error("usage: synth.mjs <context.json> <out dir>");
  const kitDir = dirname(fileURLToPath(import.meta.url));
  const input = JSON.parse(readFileSync(contextFile, "utf8")) as { context?: unknown };
  const context = checkedContext(input.context);
  const env = context.agentxEnv;
  if (env === undefined || env === "") throw new Error("the context names no environment");

  registerPrebuiltCode(CodeMapSchema.parse(JSON.parse(readFileSync(join(kitDir, KIT_CODE_MAP_FILE), "utf8"))).functions);

  const app = quiet(() => buildAgentXApp({ ...context, outdir: join(process.cwd(), "cdk.out") }));
  const assembly = quiet(() => app.synth());
  assertNoLookups(assembly.manifest);

  mkdirSync(join(outDir, "templates"), { recursive: true });
  mkdirSync(join(outDir, "packages"), { recursive: true });
  const stacks = new Map(assembly.stacks.map((stack) => [stack.stackName, stack]));
  const assets = new Map<string, PackageAccumulator>();
  for (const part of BUILT_PARTS satisfies readonly BuiltPart[]) {
    const stack = stacks.get(environmentStackName(env, part));
    if (stack === undefined) continue; // (the identity stack of an install with its own OIDC provider)
    writeFileSync(join(outDir, "templates", `${part}.template.json`), `${JSON.stringify(stack.template, null, 2)}\n`, "utf8");
    for (const asset of stack.assets) accumulateAsset(assets, asset, part, "");
  }

  const packages = [...assets.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0)).map((asset) => {
    const source = join(kitDir, kitCodeFile(asset.assetId));
    if (!existsSync(source)) throw new Error(`the kit carries no code package ${asset.assetId.slice(0, 16)}`);
    copyFileSync(source, join(outDir, "packages", `${asset.assetId}.zip`));
    return { assetId: asset.assetId, parts: [...new Set(asset.parts)].sort() as BuiltPart[], bucketParameter: asset.bucketParameter, keyParameter: asset.keyParameter, hashParameter: asset.hashParameter };
  });
  writeFileSync(join(outDir, SYNTH_OUTPUT_FILE), `${JSON.stringify(SynthOutputSchema.parse({ schemaVersion: 1, packages }), null, 2)}\n`, "utf8");
}

try {
  main();
} catch (error) {
  process.stderr.write(`synthesis kit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
