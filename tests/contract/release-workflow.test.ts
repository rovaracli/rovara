import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CLOUD_REPOSITORY, PUBLIC_REPOSITORY, conditionFor } from "../support/workflow-expression.js";

interface Step {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  shell?: string;
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  "runs-on"?: string;
  needs?: string | string[];
  "continue-on-error"?: boolean | string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

async function workflowText(): Promise<string> {
  return readFile(".github/workflows/release.yml", "utf8");
}

async function workflow(): Promise<Workflow> {
  return YAML.parse(await workflowText()) as Workflow;
}

/** A `run:` script as the shell reads it: a backslash at the end of a line joins it to the next one, so `cmd \` + `|| true` is one command. */
function logicalLines(run: string): string[] {
  return run.replace(/\\[ \t]*\r?\n/gu, " ").split("\n");
}
/** What lets a failing gating command go on: anything chained after it, a pipe, a background, a negation, `|| true`, `|| :`, a trailing `;`. Empty when the line is only the command and its arguments. */
const SWALLOWS_FAILURE = /\|\||;|&|\||!\s*npm|\bcontinue-on-error\b|\bset\s+\+e\b|\btrue\s*$|\s:\s*$/u;
function gatingCommandProblems(run: string, command: string): string[] {
  const lines = logicalLines(run).filter((line) => line.includes(command));
  if (lines.length !== 1) return [`${command} appears on ${String(lines.length)} logical lines, expected one`];
  const line = lines[0]!;
  const problems: string[] = [];
  if (!line.trimStart().startsWith(command)) problems.push(`${command} does not start its line`);
  // The arguments may use `"${image_flags[@]}"` and `$RUNNER_TEMP`, never an operator: strip quoted text first, so a `;` or `&` inside a quoted argument is not mistaken for one.
  const bare = line.replace(/"[^"]*"/gu, '""').replace(/'[^']*'/gu, "''");
  if (SWALLOWS_FAILURE.test(bare)) problems.push(`${command} is followed by something that can swallow its failure: ${line.trim()}`);
  return problems;
}
/** A package.json script the kit, verify or bundle step runs: one `tsx scripts/release/<name>.ts` and nothing else. No operator, no continuation, no second command, no flag that weakens the check. */
const RELEASE_SCRIPT = /^tsx scripts\/release\/[a-z-]+\.ts$/u;
function releaseScriptProblems(name: string, command: string, scripts: Record<string, string>, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const problems: string[] = [];
  if (!RELEASE_SCRIPT.test(command)) problems.push(`package.json script ${name} is not a bare \`tsx scripts/release/<name>.ts\`: ${JSON.stringify(command)}`);
  if (/\\\s*$/mu.test(command) || /\n/u.test(command)) problems.push(`package.json script ${name} spans lines`);
  if (/\|\||;|&|\||\btrue\b|continue-on-error|allow-unsandboxed|--no-verify/u.test(command)) problems.push(`package.json script ${name} can swallow a failure or weaken a check`);
  // npm runs pre<name> and post<name> by themselves: one of those could run anything around the gate.
  for (const hook of [`pre${name}`, `post${name}`]) if (Object.hasOwn(scripts, hook)) problems.push(`package.json has a ${hook} script, which npm runs around ${name}`);
  for (const match of command.matchAll(/npm run ([\w:-]+)/gu)) if (scripts[match[1]!] !== undefined) problems.push(...releaseScriptProblems(match[1]!, scripts[match[1]!]!, scripts, seen));
  return problems;
}


/**
 * What in a `run:` script could execute, load or source something from the downloaded artifact folder: the folder (any spelling of it) anywhere but as the value of `--bundle`, a `cd` into it,
 * or a NODE_OPTIONS/--require/--import that mentions it. The folder is data for the signer to read; none of it is run.
 */
function runsArtifactCode(run: string, folder: string): string[] {
  const problems: string[] = [];
  const spellings = [folder, folder.replace("$RUNNER_TEMP", "${RUNNER_TEMP}"), folder.replace("$RUNNER_TEMP", "")].filter((spelling) => spelling.length > 3);
  const stripped = run.replace(/--bundle\s+"?[^\s"]+"?/gu, "--bundle ARG");
  for (const spelling of spellings) if (stripped.includes(spelling)) problems.push(`uses ${spelling} other than as --bundle`);
  if (/\bcd\s+"?\$\{?RUNNER_TEMP/u.test(stripped) || /\bcd\s+"?[^\n]*\/bundle\b/u.test(stripped)) problems.push("changes into the artifact folder");
  return problems;
}

describe("release workflow", () => {
  it("runs only on version tags or by hand, never on pull requests or branch pushes", async () => {
    const wf = await workflow();
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(wf.on.push).toEqual({ tags: ["v[0-9]+.[0-9]+.[0-9]+"] });
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  it("takes the version only from the tag: workflow_dispatch has no inputs, nothing reads inputs.*", async () => {
    const wf = await workflow();
    // "by hand" still means re-running from the tag ref itself (the guard test below enforces
    // that); it must not accept an operator-typed version that could disagree with the tag.
    expect((wf.on.workflow_dispatch as Record<string, unknown> | null | undefined)?.inputs).toBeUndefined();
    const text = await workflowText();
    expect(text).not.toMatch(/inputs\.version/);
    expect(text).not.toMatch(/inputs\./);
  });

  it("guards every publishing job and runs the tests first", async () => {
    const wf = await workflow();
    for (const name of ["images", "release", "npm"]) {
      // As the public repository sees it; the Cloud copy adds `github.repository == 'PrepLabsAI/Rovara' &&`, which keeps every publishing job off Cloud.
      expect(conditionFor(wf.jobs[name]?.if, PUBLIC_REPOSITORY), name).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true'");
      if (wf.jobs[name]?.if?.includes("github.repository")) expect(conditionFor(wf.jobs[name]?.if, CLOUD_REPOSITORY), `${name} on Cloud`).toBe("false");
    }
    expect(wf.jobs.images?.needs).toBe("test");
    expect(conditionFor(wf.jobs.test?.if, PUBLIC_REPOSITORY)).toBeUndefined();
  });

  it("makes and checks the synthesis kit in the job that signs the bundle: verify, then kit, then bundle with --synth-kit, in a sandbox", async () => {
    const wf = await workflow();
    const bundle = wf.jobs.bundle;
    expect(bundle).toBeDefined();
    const runs = bundle!.steps.map((step) => step.run ?? "").join("\n");
    // In this order, in this one job: the release is verified, the kit is made from it (its self-checks run), and only then the bundle is signed, with that kit.
    const verify = runs.indexOf("npm run release:verify");
    const kit = runs.indexOf("npm run release:kit");
    const sign = runs.indexOf("npm run release:bundle");
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(kit).toBeGreaterThan(verify);
    expect(sign).toBeGreaterThan(kit);
    const signLine = runs.slice(sign).split("\n")[0] ?? "";
    expect(signLine).toContain('--synth-kit "$RUNNER_TEMP/kit"');
    // The build job only PREPARES the bundle: it holds no key reference and signs nothing (the sign job does).
    expect(signLine).toContain("--unsigned");
    expect(runs).not.toContain("--kms-key");
    const kitLine = runs.slice(kit).split("\n")[0] ?? "";
    expect(kitLine).toContain('--out "$RUNNER_TEMP/kit"');
    // The self-checks run in a sandbox, never without one.
    expect(runs).toContain("bubblewrap");
    expect(runs).not.toContain("--allow-unsandboxed-check");
    // The only place a bundle is signed from a workflow.
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name !== "bundle") expect(job.steps.map((step) => step.run ?? "").join("\n"), `${name} signs no bundle`).not.toContain("release:bundle");
    }
    // Guarded like the other publishing jobs, and off until the owner enables it.
    expect(conditionFor(bundle!.if, PUBLIC_REPOSITORY)).toBe("vars.AGENTX_PUBLISH_ENABLED == 'true' && vars.AGENTX_BUNDLE_ENABLED == 'true' && vars.AGENTX_BUNDLE_KMS_KEY != ''");
    expect(bundle!.if).toContain("github.repository == 'PrepLabsAI/Rovara'");
    expect(bundle!.needs).toEqual(["images", "release"]);
  });

  it("SK-4 (S1): the sign job is the ONLY job in the bundle path with id-token, AWS credentials, the signing role and the release-signing environment", async () => {
    const wf = await workflow();
    const bundle = wf.jobs.bundle!;
    const sign = wf.jobs.sign!;
    expect(sign).toBeDefined();
    // The build job: read the repository, nothing else; no token for AWS, no credentials step, no environment.
    expect(bundle.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(bundle)).not.toMatch(/id-token|configure-aws-credentials|AGENTX_BUNDLE_SIGNING_ROLE_ARN|"environment"/u);
    // The sign job: the id-token (and read access to check out the signer's source), one credentials step with the signing role variable, the environment its trust policy requires.
    expect(sign.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect((sign as { environment?: string }).environment).toBe("release-signing");
    expect(sign.needs).toBe("bundle");
    expect(conditionFor(sign.if, PUBLIC_REPOSITORY)).toBe(conditionFor(bundle.if, PUBLIC_REPOSITORY));
    expect(sign.if).toContain("github.repository == 'PrepLabsAI/Rovara'");
    const credentials = sign.steps.filter((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials") === true);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.with?.["role-to-assume"]).toBe("${{ vars.AGENTX_BUNDLE_SIGNING_ROLE_ARN }}");
    // The role variable is named in the sign job and nowhere else.
    const text = await workflowText();
    expect(text.match(/AGENTX_BUNDLE_SIGNING_ROLE_ARN/gu)).toHaveLength(1);
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === "sign") continue;
      expect(JSON.stringify(job), name).not.toContain("BUNDLE_SIGNING");
      expect(JSON.stringify(job), name).not.toContain("release-signing");
    }
  });

  it("SK-4 (S1): the signer the sign job runs is built from the TAGGED COMMIT's source and its own small lockfile, never from a file the bundle job made", async () => {
    const wf = await workflow();
    const bundle = wf.jobs.bundle!;
    const sign = wf.jobs.sign!;
    // The bundle job makes data only: it builds no signer, copies none, and uploads only the bundle folder.
    const built = bundle.steps.map((step) => step.run ?? "").join("\n");
    expect(built).not.toMatch(/esbuild|sign-bundle|signer/u);
    const uploads = bundle.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.with?.path).toBe("${{ runner.temp }}/bundle");
    // Every action in the sign job is pinned to a commit.
    for (const step of sign.steps) if (step.uses !== undefined) expect(step.uses, step.uses).toMatch(/^[\w./-]+@[0-9a-f]{40}$/u);
    // The sign job's steps, in this order: the tagged commit's source (sparse, no git credential), Node, the signer package's own install (no install scripts), the build of sign-bundle.ts from that source,
    // the data artifact, the AWS credentials (only after everything that installs or builds has run), the one run of the freshly built file, the upload of the signed folder.
    expect(sign.steps.map((step) => (step.uses ?? "").split("@")[0] || "run")).toEqual([
      "actions/checkout", "actions/setup-node", "run", "run", "actions/download-artifact", "aws-actions/configure-aws-credentials", "run", "actions/upload-artifact",
    ]);
    const checkout = sign.steps[0]!;
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(checkout.with?.ref).toBeUndefined();
    expect(String(checkout.with?.["sparse-checkout"]).split("\n").filter((line) => line !== "").sort()).toEqual(["packages/cloud-contracts/src", "scripts/release", "vendor/rovara-code/packages/contracts/src"]);
    expect(sign.steps[1]!.with?.cache).toBeUndefined();
    expect(sign.steps[1]!.with?.["node-version-file"]).toBe(".node-version");
    expect(sign.steps[2]!.run).toBe("npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/release/signer");
    // The build options (aliases, externals, the plugin that says Code's contract sources have no side effects, the outfile) are in scripts/release/signer/build.mjs, read by tests/contract/signer-package.test.ts.
    expect(sign.steps[3]!.run).toBe("node scripts/release/signer/build.mjs");
    expect(await readFile("scripts/release/signer/build.mjs", "utf8")).toContain('outfile: "scripts/release/signer/dist/sign-bundle.mjs"');
    expect(sign.steps[6]!.run).toBe('node scripts/release/signer/dist/sign-bundle.mjs --bundle "$RUNNER_TEMP/bundle" --kms-key "$KMS_KEY"');
    const download = sign.steps[4]!;
    expect(download.with?.name).toBe("bundle-unsigned");
    expect(download.with?.path).toBe("${{ runner.temp }}/bundle");
    expect(sign.steps[5]!.uses).toMatch(/^aws-actions\/configure-aws-credentials@/u);
  });

  it("SK-4 (S1): the sign job never runs a .js, .mjs, .cjs, .ts or shell file from a downloaded artifact (negative controls included)", async () => {
    const wf = await workflow();
    const sign = wf.jobs.sign!;
    const downloaded = sign.steps.filter((step) => step.uses?.startsWith("actions/download-artifact")).map((step) => String(step.with?.path));
    expect(downloaded).toHaveLength(1);
    // The artifact folder, as a run script spells it.
    const folder = downloaded[0]!.replace("${{ runner.temp }}", "$RUNNER_TEMP");
    expect(folder).toBe("$RUNNER_TEMP/bundle");
    for (const step of sign.steps) {
      const problems = runsArtifactCode(step.run ?? "", folder);
      expect(problems, step.run).toEqual([]);
    }
    // The check itself catches what it is for.
    const hostile = [
      `node "${folder}/signer/sign-bundle.mjs" --kms-key k`,
      `node ${folder}/sign-bundle.mjs`,
      `bash ${folder}/run.sh`,
      `source ${folder}/env.sh`,
      `. ${folder}/env.sh`,
      `chmod +x ${folder}/x && ${folder}/x`,
      `${folder}/x`,
      `npx tsx ${folder}/x.ts`,
      `cd ${folder} && node sign-bundle.mjs`,
      `cd "${folder}"\nnode ./sign-bundle.mjs`,
      `node -e "import('${folder}/x.mjs')"`,
      `NODE_OPTIONS="--require ${folder}/x.cjs" node scripts/release/signer/dist/sign-bundle.mjs`,
    ];
    for (const run of hostile) expect(runsArtifactCode(run, folder).length, run).toBeGreaterThan(0);
    // And lets the one legitimate use through: the folder as the --bundle argument of the signer built from the checkout.
    expect(runsArtifactCode(`node scripts/release/signer/dist/sign-bundle.mjs --bundle "${folder}" --kms-key "$KMS_KEY"`, folder)).toEqual([]);
  });

  it("SK-4: nothing in the signing job can let a failed kit, verify or sign step go on: no `|| true`, no `;` after them, no continue-on-error, no `set +e`, no weakened shell", async () => {
    const wf = await workflow();
    const bundle = wf.jobs.bundle!;
    expect(bundle["continue-on-error"]).toBeUndefined();
    expect(wf.jobs.sign!["continue-on-error"]).toBeUndefined();
    for (const step of [...bundle.steps, ...wf.jobs.sign!.steps]) {
      expect(step["continue-on-error"], `step ${step.name ?? step.run?.slice(0, 30) ?? step.uses ?? ""}`).toBeUndefined();
      // The default shell is `bash -e -o pipefail`; a step may not choose another one (sh without -e, `bash +e`, pwsh) for the commands that gate the signing.
      if (step.run !== undefined && /release:(kit|verify|bundle)/u.test(step.run)) expect(step.shell, "the shell of the step that makes and signs the kit").toBeUndefined();
      expect(step.run ?? "").not.toMatch(/set\s+\+e|set\s+\+o\s+errexit/u);
    }
    const runs = bundle.steps.map((step) => step.run ?? "").join("\n");
    // Each gating command is the whole of its (logical) line, up to the arguments: nothing chained after it that could swallow its failure, and no `\\` continuation that moves the `|| true` to the next line.
    for (const command of ["npm run release:verify", "npm run release:kit", "npm run release:bundle"]) expect(gatingCommandProblems(runs, command), command).toEqual([]);
    // The build the kit reads is a fresh one made in this job.
    const ci = bundle.steps.findIndex((step) => step.run === "npm ci");
    const build = bundle.steps.findIndex((step) => step.run === "npm run build");
    const kitStep = bundle.steps.findIndex((step) => (step.run ?? "").includes("npm run release:kit"));
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(ci);
    expect(kitStep).toBeGreaterThan(build);
  });

  it("SK-4: the gating check itself catches a `\\` continuation, `|| true`, `;`, a pipe, a background and a second line (negative controls)", () => {
    const ok = 'npm run release:kit -- --release "$RUNNER_TEMP/release" --out "$RUNNER_TEMP/kit"';
    expect(gatingCommandProblems(ok, "npm run release:kit")).toEqual([]);
    expect(gatingCommandProblems(`${ok} --note "a; b && c"`, "npm run release:kit"), "operators inside a quoted argument are text").toEqual([]);
    const hostile: Record<string, string> = {
      "|| true": `${ok} || true`,
      "|| true on the next line": `${ok} \\\n  || true`,
      "continuation then a semicolon": `${ok} \\\n ; echo done`,
      "continuation with trailing spaces": `${ok} \\  \n  || true`,
      "|| :": `${ok} || :`,
      "pipe to cat": `${ok} | cat`,
      "pipe to tee": `${ok} |& tee kit.log`,
      "background": `${ok} &`,
      "semicolon": `${ok}; true`,
      "and true": `${ok} && true`,
      "negated": `! ${ok}`,
      "run twice": `${ok}\n${ok}`,
      "not run at all": "echo skipped",
    };
    for (const [name, run] of Object.entries(hostile)) expect(gatingCommandProblems(run, "npm run release:kit").length, name).toBeGreaterThan(0);
  });

  it("SK-4: the package.json scripts the signing job calls are each one bare `tsx scripts/release/<name>.ts`: no `|| true`, no `\\` continuation, no chained command, no pre/post hook", async () => {
    const scripts = (JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const name of ["release:verify", "release:kit", "release:bundle"]) {
      expect(scripts[name], name).toBeDefined();
      expect(releaseScriptProblems(name, scripts[name]!, scripts), name).toEqual([]);
    }
  });

  it("SK-4: the package.json script check catches `|| true`, a continuation, a chained command, a hook and a nested script (negative controls)", () => {
    const clean = { "release:kit": "tsx scripts/release/synth-kit.ts" };
    expect(releaseScriptProblems("release:kit", clean["release:kit"], clean)).toEqual([]);
    const hostile: Record<string, Record<string, string>> = {
      "|| true": { "release:kit": "tsx scripts/release/synth-kit.ts || true" },
      "continuation": { "release:kit": "tsx scripts/release/synth-kit.ts \\\n || true" },
      "semicolon": { "release:kit": "tsx scripts/release/synth-kit.ts; echo ok" },
      "and": { "release:kit": "tsx scripts/release/synth-kit.ts && true" },
      "pipe": { "release:kit": "tsx scripts/release/synth-kit.ts | cat" },
      "unsandboxed flag": { "release:kit": "tsx scripts/release/synth-kit.ts --allow-unsandboxed-check" },
      "another program": { "release:kit": "node other.js" },
      "pre hook": { ...clean, "prerelease:kit": "echo hi" },
      "post hook": { ...clean, "postrelease:kit": "echo hi" },
      "nested npm run": { "release:kit": "npm run kit-inner", "kit-inner": "tsx scripts/release/synth-kit.ts || true" },
    };
    for (const [name, scripts] of Object.entries(hostile)) expect(releaseScriptProblems("release:kit", scripts["release:kit"]!, scripts).length, name).toBeGreaterThan(0);
  });

  it("SK-4: no package.json script passes --allow-unsandboxed-check (the flag is for a developer's own computer, typed by hand)", async () => {
    const scripts = (JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts)).toContain("release:kit");
    for (const [name, command] of Object.entries(scripts)) expect(command, `package.json script ${name}`).not.toContain("allow-unsandboxed");
    // And nothing else the workflows run: not in any workflow file.
    for (const file of ["release.yml", "ci.yml"]) {
      const text = await readFile(`.github/workflows/${file}`, "utf8").catch(() => "");
      expect(text, file).not.toContain("--allow-unsandboxed-check");
    }
  });

  it("the test job runs typecheck, lint, build, test and infra:synth", async () => {
    const wf = await workflow();
    const testRun = wf.jobs.test!.steps.map((s) => s.run ?? "").join("\n");
    expect(testRun).toContain("npm run typecheck");
    expect(testRun).toContain("npm run lint");
    expect(testRun).toContain("npm run build");
    expect(testRun).toContain("npm test");
    expect(testRun).toContain("npm run infra:synth");
    // In the declared order, so a later step can't silently run against a stale build.
    expect(testRun.indexOf("npm run lint")).toBeLessThan(testRun.indexOf("npm run build"));
    expect(testRun.indexOf("npm run build")).toBeLessThan(testRun.indexOf("npm test"));
    expect(testRun.indexOf("npm test")).toBeLessThan(testRun.indexOf("npm run infra:synth"));
  });

  it("grants OIDC and write access only where they are needed", async () => {
    const wf = await workflow();
    expect(wf.jobs.test?.permissions).toBeUndefined();
    expect(wf.jobs.images?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(wf.jobs.release?.permissions).toEqual({ contents: "write" });
    expect(wf.jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("builds arm64 images with buildx, pushes a single-manifest image, and cross-checks the registry digest before publishing", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    const buildxIndex = steps.findIndex((s) => s.uses?.startsWith("docker/setup-buildx-action"));
    expect(buildxIndex).toBeGreaterThanOrEqual(0);
    const push = steps.map((s) => s.run ?? "").join("\n");
    const buildIndex = push.indexOf("docker buildx build");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    // setup-buildx-action must run as an earlier *step* than the one containing the build.
    const pushStepIndex = steps.findIndex((s) => (s.run ?? "").includes("docker buildx build"));
    expect(buildxIndex).toBeLessThan(pushStepIndex);

    expect(push).toContain("--platform linux/arm64");
    // Without these, buildx pushes an OCI index (image + attestations), not a single arm64
    // manifest, and the digest read back would be the index's, not the image's.
    expect(push).toContain("--provenance=false");
    expect(push).toContain("--sbom=false");
    expect(push).toContain("containerimage.digest");

    // The registry, not just the local build metadata, must confirm what got pushed.
    expect(push).toContain("docker buildx imagetools inspect");
    expect(push).toMatch(/imagetools inspect "\$repo:\$VERSION" --format '\{\{json \.Manifest\.Digest\}\}'/);
    expect(push).toMatch(/registry_digest/);
    // Fails on an empty/null registry digest, and on a mismatch against the pushed digest.
    expect(push).toMatch(/registry_digest"\s*\]\s*\|\|\s*\[\s*"\$registry_digest"\s*=\s*"null"/);
    expect(push).toMatch(/"\$registry_digest"\s*!=\s*"\$digest"/);
    expect(push).toContain("exit 1");
    expect(push).toContain("@$registry_digest");

    const release = wf.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(release.indexOf("release:verify")).toBeGreaterThan(release.indexOf("release:build"));
    expect(release.indexOf("gh release create")).toBeGreaterThan(release.indexOf("release:verify"));
    expect(release).toContain('--worker-image "$WORKER"');
    // The browser executor ships with every release, built for linux/arm64 from its own Dockerfile and pinned by the same
    // registry-confirmed digest as the worker, and recorded in release.json for the runtime stack to take.
    expect(wf.jobs.images!.outputs?.executor).toBe("${{ steps.push.outputs.executor }}");
    // Off by default: a tagged release must not fail on a repository the owner has not created yet.
    expect(push).toContain('if [ "$PUBLISH_EXECUTOR" = "true" ]; then images="executor $images"; fi');
    expect(push).toContain("for image in $images; do");
    expect(wf.jobs.images!.steps.find((step) => step.id === "push")?.env?.PUBLISH_EXECUTOR).toBe("${{ vars.AGENTX_PUBLISH_EXECUTOR_IMAGE }}");
    expect(push).toContain("environments/e2e-executor/Dockerfile");
    // The flag is passed only when the images job produced an executor digest.
    expect(release).toContain('if [ -n "$EXECUTOR" ]; then executor_flag=(--executor-image "$EXECUTOR"); fi');
    expect(release).toContain('"${executor_flag[@]}"');
    expect(wf.jobs.release!.steps.some((s) => s.env?.EXECUTOR === "${{ needs.images.outputs.executor }}")).toBe(true);
    expect(wf.jobs.release!.steps.some((s) => s.env?.GH_TOKEN === "${{ github.token }}")).toBe(true);
  });

  it("smoke-tests the executor image under its production sandbox before it is pushed, and pushes the very image it tested", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    const index = (match: (step: (typeof steps)[number]) => boolean) => steps.findIndex(match);
    const text = (step: (typeof steps)[number]) => step.run ?? "";
    const awsIndex = index((step) => step.uses?.startsWith("aws-actions/configure-aws-credentials") === true);
    const pushIndex = index((step) => step.id === "push");
    // Dependencies, the build and the userns sysctl come before any AWS credential exists, and only when the executor is published.
    const npmIndex = index((step) => text(step).includes("npm ci") && text(step).includes("npm run build"));
    const nodeIndex = index((step) => step.uses?.startsWith("actions/setup-node") === true);
    const sysctlIndex = index((step) => text(step).includes("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"));
    for (const found of [nodeIndex, npmIndex, sysctlIndex]) { expect(found).toBeGreaterThanOrEqual(0); expect(found).toBeLessThan(awsIndex); expect(steps[found]!.if).toBe("vars.AGENTX_PUBLISH_EXECUTOR_IMAGE == 'true'"); }
    expect(nodeIndex).toBeLessThan(npmIndex);
    expect(awsIndex).toBeLessThan(pushIndex);
    expect(wf.jobs.images!["runs-on"]).toBe("ubuntu-24.04-arm");
    // The executor branch: build into the local Docker, smoke through the shared script, then push that image; it never builds with --push.
    const push = text(steps[pushIndex]!);
    const branch = push.slice(push.indexOf('if [ "$image" = executor ]; then'), push.indexOf("else\n"));
    expect(branch).toContain("--platform linux/arm64");
    expect(branch).toContain("--load");
    expect(branch).not.toContain("--push");
    expect(branch).toContain('npx tsx scripts/executor-smoke.ts "$repo:$VERSION"');
    expect(branch.indexOf("--load")).toBeLessThan(branch.indexOf("executor-smoke.ts"));
    expect(branch.indexOf("executor-smoke.ts")).toBeLessThan(branch.indexOf('docker push "$repo:$VERSION"'));
    expect(branch).toContain("digest=$(docker push");
    // The registry still confirms what was pushed, whichever branch pushed it.
    expect(push.indexOf("registry_digest=$(")).toBeGreaterThan(push.indexOf("docker push"));
    expect(push).not.toMatch(/--no-sandbox|seccomp=unconfined/);
  });

  it("builds, smokes and pushes the executor before it pushes the worker or the slack image (Ruling AI)", async () => {
    // Image tags are immutable once pushed: a failing executor smoke after the worker and slack
    // pushes would leave half a release in the registry. Run the push step's own list-building
    // lines to see the order the loop would take, rather than matching text.
    const wf = await workflow();
    const push = wf.jobs.images!.steps.find((step) => step.id === "push")!.run!;
    const lines = push.split("\n").filter((line) => /^\s*images=|^\s*if \[ "\$PUBLISH_EXECUTOR"/.test(line)).join("\n");
    const order = (flag: string) => execFileSync("bash", ["-c", `PUBLISH_EXECUTOR=${flag}\n${lines}\necho "$images"`], { encoding: "utf8" }).trim();
    expect(order("true")).toBe("executor worker slack");
    expect(order("")).toBe("worker slack");
  });

  it("runs the images push step with shell: bash, so a failing `imagetools inspect | tr` fails the step instead of being swallowed by the pipe", async () => {
    const wf = await workflow();
    const push = wf.jobs.images!.steps.find((s) => s.id === "push");
    expect(push).toBeDefined();
    // Without an explicit shell, GitHub Actions runs a Linux run: step as plain `bash -e {0}`, not
    // `bash --noprofile --norc -eo pipefail {0}`; only shell: bash turns pipefail on.
    expect(push?.shell).toBe("bash");
  });

  it("never prints secrets", async () => {
    const text = await workflowText();
    expect(text).not.toMatch(/echo[^\n]*secrets\./);
    expect(text).not.toMatch(/set -x/);
  });

  it("no run: script interpolates a GitHub Actions expression; everything flows through env", async () => {
    const wf = await workflow();
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps) {
        if (step.run) expect(step.run, `${jobName}: ${step.run}`).not.toContain("${{");
      }
    }
  });

  it("refuses to run the images job's publishing steps unless the ref is a version tag matching vX.Y.Z", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    // The publish role's trust policy only allows this repository's v* tags, so a
    // workflow_dispatch run started from a branch would otherwise fail deep inside
    // configure-aws-credentials with an opaque AssumeRoleWithWebIdentity error. Guard first, and
    // fail clearly, before checkout or any AWS action runs. GITHUB_REF/GITHUB_REF_NAME are the
    // runner's own default env vars, read directly rather than interpolated in as `${{ github.ref
    // }}` (see the "no run: script interpolates" test above).
    const guardIndex = steps.findIndex((s) => (s.run ?? "").includes("GITHUB_REF"));
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const guard = steps[guardIndex]!;
    expect(guard.run).toContain("$GITHUB_REF");
    expect(guard.run).toMatch(/refs\/tags\/v\*/);
    expect(guard.run).toContain("$GITHUB_REF_NAME");
    expect(guard.run).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    expect(guard.run).toMatch(/exit 1/);
    const checkoutIndex = steps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkoutIndex).toBeGreaterThan(guardIndex);
    const credentialsIndex = steps.findIndex((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials"));
    expect(credentialsIndex).toBeGreaterThan(guardIndex);
  });

  it("refuses to publish a tag whose commit is not on mainline, before checkout or any AWS action runs", async () => {
    const wf = await workflow();
    const steps = wf.jobs.images!.steps;
    // A vX.Y.Z tag on a feature branch's commit would otherwise publish unreviewed code. The
    // compare API's "identical" or "behind" means the tagged commit is mainline's tip or an ancestor.
    const guardIndex = steps.findIndex((s) => (s.run ?? "").includes("/compare/mainline..."));
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    const guard = steps[guardIndex]!;
    expect(guard.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(guard.run).toContain("repos/$GITHUB_REPOSITORY/compare/mainline...$GITHUB_SHA");
    expect(guard.run).toMatch(/!= identical && "\$status" != behind/);
    expect(guard.run).toMatch(/exit 1/);
    const checkoutIndex = steps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkoutIndex).toBeGreaterThan(guardIndex);
    const credentialsIndex = steps.findIndex((s) => s.uses?.startsWith("aws-actions/configure-aws-credentials"));
    expect(credentialsIndex).toBeGreaterThan(guardIndex);
  });

  it("publishes npm with trusted publishing (OIDC): no stored token, npm upgraded to 11 first, no --provenance flag (trusted publishing adds it)", async () => {
    const text = await workflowText();
    expect(text).not.toMatch(/NPM_TOKEN/);
    expect(text).not.toMatch(/NODE_AUTH_TOKEN/);

    const wf = await workflow();
    const npmSteps = wf.jobs.npm!.steps;
    const upgradeIndex = npmSteps.findIndex((s) => (s.run ?? "").includes("npm install -g npm@11"));
    const publishIndex = npmSteps.findIndex((s) => (s.run ?? "").includes("npm publish"));
    expect(upgradeIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(upgradeIndex);
    expect(npmSteps[publishIndex]!.run).toContain("--access public");
    // Trusted publishing adds provenance automatically for this public repository; no flag needed.
    expect(npmSteps[publishIndex]!.run).not.toContain("--provenance");
  });

  it("builds the workspace (npm run build) before any release: script runs, in every job that invokes one", async () => {
    const wf = await workflow();
    for (const [name, job] of Object.entries(wf.jobs)) {
      const runs = job.steps.map((s) => s.run ?? "");
      const releaseScriptIndex = runs.findIndex((r) => /\brelease:/.test(r));
      if (releaseScriptIndex === -1) continue;
      const buildIndex = runs.findIndex((r) => /\bnpm run build\b/.test(r));
      expect(buildIndex, `${name} job must run "npm run build" before any release: script`).toBeGreaterThanOrEqual(0);
      expect(buildIndex, name).toBeLessThan(releaseScriptIndex);
    }
    // Sanity: this test only means something if at least one job actually invokes a release: script.
    const anyReleaseScript = Object.values(wf.jobs).some((job) => job.steps.some((s) => /\brelease:/.test(s.run ?? "")));
    expect(anyReleaseScript).toBe(true);
  });

  it("has a top-level concurrency group keyed by ref, and never cancels a release already in flight", async () => {
    const wf = await workflow();
    expect(wf.concurrency).toEqual({ group: "release-${{ github.ref }}", "cancel-in-progress": false });
  });

  it("does not persist a git credential after checkout in the images, release and npm jobs", async () => {
    const wf = await workflow();
    for (const name of ["images", "release", "npm"]) {
      const checkout = wf.jobs[name]!.steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkout, name).toBeDefined();
      expect(checkout!.with?.["persist-credentials"], name).toBe(false);
    }
  });

  it("skips npm publish instead of failing when the version is already on the registry", async () => {
    const wf = await workflow();
    const npmRun = wf.jobs.npm!.steps.map((s) => s.run ?? "").join("\n");
    expect(npmRun).toMatch(/npm view "\$NAME@\$VERSION" version/);
    expect(npmRun).toMatch(/already published[^\n]*skipping/);
    const viewIndex = npmRun.indexOf("npm view");
    const publishIndex = npmRun.lastIndexOf("npm publish");
    expect(viewIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(viewIndex);
  });
});
