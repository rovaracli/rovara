import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, EnvironmentNameSchema, renderTemplate } from "@rovara-code/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { evaluate } from "../support/cfn-evaluate.js";

/**
 * Why this file is fast: building the app (not synthesizing it) is what costs. Construction bundles every Lambda with esbuild (about 13 s per app on the Mac, over 60 s on a shared free CI runner), and this file builds
 * eleven apps. None of its tests is about the Lambda bundles: they check the name replacement, the guard clauses and where the context is read from. CDK's own switch for that, an empty `aws:cdk:bundling-stacks` list,
 * keeps every construct and every template but stages each Lambda's code without running its bundler (the build drops from about 13 s to 0.1 s; the only difference in a template is the content hash in an asset parameter's
 * name, which both sides of every comparison here carry alike). Real bundling stays covered by the tests that synthesize for release.
 */
const NO_BUNDLING = { "aws:cdk:bundling-stacks": [] } as const;

function templates(env: string): Map<string, string> {
  // A published template is the placeholder environment's, with the name replaced. The audit ledger's Object Lock
  // default depends on the name (governance for staging, test and dev*, compliance for the rest), which a text
  // replacement cannot follow, so the published template always carries the safe default: compliance, 1,096 days.
  // Pinning it for the direct synth keeps this test about what it checks, the fidelity of the name replacement.
  const assembly = buildAgentXApp({ ...NO_BUNDLING, agentxEnv: env, agentxSynthesizer: "legacy", agentxAuditLockMode: "COMPLIANCE", agentxAuditRetentionDays: 1096 }).synth();
  const byPart = new Map<string, string>();
  for (const stack of assembly.stacks) {
    const part = stack.stackName.replace(`agentx-${env}-`, "");
    byPart.set(part, JSON.stringify(stack.template));
  }
  return byPart;
}

/**
 * The task person proof function is a resource of every environment since 0.5.15 (feat/0515-task-people-v3), and its published version's logical id carries CDK's hash of the function's
 * properties, which include AGENTX_ENV. A text replacement cannot follow a hash of the name, so the rendered template keeps the placeholder environment's hash (a stable id that changes
 * with the function's code and settings, which is all a version's id is for) while a direct synth hashes its own name. Everything else must still match exactly: only that hash is left out.
 */
function withoutVersionHash(template: string): string {
  return template.replace(/(TaskPersonProofFunctionCurrentVersion5D5638F1)[0-9a-f]{32}/g, "$1<hash>");
}

function withCdkContextJson(value: Record<string, unknown>, run: () => void): void {
  const original = process.env[CONTEXT_ENV];
  try {
    process.env[CONTEXT_ENV] = JSON.stringify(value);
    run();
  } finally {
    if (original === undefined) delete process.env[CONTEXT_ENV];
    else process.env[CONTEXT_ENV] = original;
  }
}

/** Simulates CDK's own context-overflow temp file (used instead of CDK_CONTEXT_JSON when the
 * context is too large for an environment variable): writes `value` to a temp JSON file and points
 * CONTEXT_OVERFLOW_LOCATION_ENV at it for the duration of `run`. */
function withContextOverflowFile(value: Record<string, unknown>, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agentx-context-overflow-"));
  const file = join(dir, "context-overflow.json");
  writeFileSync(file, JSON.stringify(value));
  const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
  try {
    process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = file;
    run();
  } finally {
    if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
    rmSync(dirname(file), { recursive: true, force: true });
  }
}

describe("templates for any environment", () => {
  // The placeholder app is identical across every test in this file, so it is synthesized once here and reused,
  // instead of once per test/case as the brief's inline snippet would (this changes nothing about
  // what each test asserts). It skips Lambda bundling (see NO_BUNDLING above).
  let placeholderTemplates: Map<string, string>;

  beforeAll(() => {
    placeholderTemplates = templates(ENVIRONMENT_PLACEHOLDER);
  }, 120_000);

  it("uses a placeholder that is a valid name and that no real environment can take", () => {
    expect(ENVIRONMENT_PLACEHOLDER).toBe("qqenv-placeholderqq");
    expect(EnvironmentNameSchema.safeParse(ENVIRONMENT_PLACEHOLDER).success).toBe(true);
    expect(EnvironmentNameSchema.safeParse("myqqenv").success).toBe(false);
  });

  it("needs no CDK bootstrap and takes code package locations as parameters", () => {
    for (const [part, text] of placeholderTemplates) {
      expect(text, part).not.toContain("cdk-hnb659fds");
      expect(text, part).not.toContain("BootstrapVersion");
    }
    expect(placeholderTemplates.get("control-plane")).toMatch(/AssetParameters[0-9a-f]{64}S3Bucket/);
  });

  it.each(["staging", "dev-2"])("renders to exactly what CDK synthesizes for %s", (env) => {
    const direct = templates(env);
    expect([...placeholderTemplates.keys()].sort()).toEqual([...direct.keys()].sort());
    for (const [part, text] of placeholderTemplates) {
      expect(withoutVersionHash(renderTemplate(text, env)), part).toBe(withoutVersionHash(direct.get(part)!));
    }
  });

  it("a published template offers the audit lock profile and defaults to production, for any name it is rendered for (Task 5b)", () => {
    for (const env of ["staging", "dev-2", "acme"]) {
      const template = JSON.parse(renderTemplate(placeholderTemplates.get("control-plane")!, env)) as {
        Parameters: Record<string, { Default?: string; AllowedValues?: string[] }>;
        Conditions: Record<string, unknown>;
        Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
      };
      expect(template.Parameters.AuditLockProfile).toMatchObject({ Default: "production", AllowedValues: ["production", "trial"] });
      const [, bucket] = Object.entries(template.Resources).find(([id, resource]) => resource.Type === "AWS::S3::Bucket" && id.startsWith("AuditLedgerAuditLedgerBucket"))!;
      const lock = (profile?: string) => evaluate(bucket.Properties.ObjectLockConfiguration, { parameters: { AuditLockProfile: profile ?? template.Parameters.AuditLockProfile!.Default! }, conditions: template.Conditions });
      expect(lock()).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1096 } } });
      expect(lock("production")).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 1096 } } });
      expect(lock("trial")).toStrictEqual({ ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 1 } } });
    }
  });

  it("refuses an invalid environment and refuses output that still holds the placeholder", () => {
    expect(() => renderTemplate("x", "Bad")).toThrow(/environment name/);
    expect(() => renderTemplate("qqenv", "staging")).toThrow(/placeholder/);
  });

  it("refuses to render the identity template (which carries a Cognito hosted UI domain) for an environment name Cognito would reject, even though the placeholder synth itself succeeded", () => {
    const identityText = placeholderTemplates.get("identity");
    expect(identityText).toContain("AWS::Cognito::UserPoolDomain");
    expect(() => renderTemplate(identityText!, "aws-dev")).toThrow(/Cognito domain/);
  });

  it("renders a non-identity template (no Cognito user pool domain) for that same environment name without issue", () => {
    const foundationText = placeholderTemplates.get("foundation");
    expect(foundationText).not.toContain("AWS::Cognito::UserPoolDomain");
    expect(() => renderTemplate(foundationText!, "aws-dev")).not.toThrow();
  });

  it("is refused for the deployment that predates environments", () => {
    expect(() => buildAgentXApp({ agentxSynthesizer: "legacy" })).toThrow(/named environment/);
  });

  it("refuses an unsupported agentxSynthesizer value, naming it", () => {
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "bogus" })).toThrow(/bogus/);
  });
});

/**
 * `cdk synth -c agentxEnv=... -c agentxSynthesizer=legacy` reaches bin/agentx.ts, which calls
 * buildAgentXApp() with no arguments at all: the `cdk` CLI passes `-c` flags (and cdk.json) to the
 * app it shells out to via the CDK_CONTEXT_JSON environment variable, not by calling this function
 * with a context object. Reading only the function argument (as buildAgentXApp did before) silently
 * ignored that entirely and produced bootstrap-dependent templates instead of honoring or refusing
 * the request.
 */
describe("agentxSynthesizer from CDK_CONTEXT_JSON (how the cdk CLI actually passes -c flags)", () => {
  it("synthesizes bootstrap-free templates from agentxEnv/agentxSynthesizer alone", () => {
    withCdkContextJson({ agentxEnv: "staging", agentxSynthesizer: "legacy" }, () => {
      const assembly = buildAgentXApp(NO_BUNDLING).synth();
      const text = assembly.stacks.map((stack) => JSON.stringify(stack.template)).join("\n");
      expect(text).not.toContain("cdk-hnb659fds");
      expect(text).not.toContain("BootstrapVersion");
    });
  });

  it("refuses an unsupported agentxSynthesizer value, naming it", () => {
    withCdkContextJson({ agentxEnv: "staging", agentxSynthesizer: "bogus" }, () => {
      expect(() => buildAgentXApp()).toThrow(/bogus/);
    });
  });

  it("refuses agentxSynthesizer=legacy with no named environment", () => {
    withCdkContextJson({ agentxSynthesizer: "legacy" }, () => {
      expect(() => buildAgentXApp()).toThrow(/named environment/);
    });
  });

  it("gives CDK_CONTEXT_JSON precedence over the context argument for the pre-App guard, matching how App itself merges context for every other key", () => {
    withCdkContextJson({ agentxSynthesizer: "bogus" }, () => {
      // The context argument's agentxSynthesizer disagrees with CDK_CONTEXT_JSON's. Once
      // `new App(...)` runs, App.loadContext would give CDK_CONTEXT_JSON the final say for every
      // other context key regardless of what this argument says, so the pre-App guard (which must
      // decide the synthesizer before construction) has to honor the same precedence: it must
      // reject "bogus", not silently accept the argument's "legacy".
      expect(() => buildAgentXApp({ agentxSynthesizer: "legacy", agentxEnv: "staging" })).toThrow(/bogus/);
    });
  });

  it("throws a clear error naming CDK_CONTEXT_JSON when it is malformed, instead of a raw SyntaxError", () => {
    const original = process.env[CONTEXT_ENV];
    try {
      process.env[CONTEXT_ENV] = "{not json";
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "legacy" })).toThrow(new RegExp(CONTEXT_ENV));
    } finally {
      if (original === undefined) delete process.env[CONTEXT_ENV];
      else process.env[CONTEXT_ENV] = original;
    }
  });
});

describe("context-overflow temp file (App's own readContextFromTempFile, layered like App.loadContext)", () => {
  it("is read the same way App reads it, and feeds the pre-App guard clauses", () => {
    withContextOverflowFile({ agentxSynthesizer: "legacy", agentxEnv: "overflow-env" }, () => {
      const app = buildAgentXApp(NO_BUNDLING);
      expect(app.node.tryGetContext("agentxEnv")).toBe("overflow-env");
    });
  });

  it("wins over CDK_CONTEXT_JSON for a key both set, matching App.loadContext's own layering ({...environment, ...tempFile})", () => {
    withCdkContextJson({ agentxSynthesizer: "bogus" }, () => {
      withContextOverflowFile({ agentxSynthesizer: "legacy", agentxEnv: "staging" }, () => {
        // If CDK_CONTEXT_JSON still won, this would throw naming "bogus" instead.
        expect(() => buildAgentXApp(NO_BUNDLING)).not.toThrow();
      });
    });
  });

  it(`throws a clear error naming ${CONTEXT_OVERFLOW_LOCATION_ENV} when the file it points to is not valid JSON`, () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-context-overflow-bad-"));
    const file = join(dir, "context-overflow.json");
    writeFileSync(file, "{not json");
    const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    try {
      process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = file;
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "legacy" })).toThrow(
        new RegExp(CONTEXT_OVERFLOW_LOCATION_ENV),
      );
    } finally {
      if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
      else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an empty value, matching App's own readContextFromTempFile (`location ? ... : {}`)", () => {
    const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    try {
      process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = "";
      expect(() => buildAgentXApp({ ...NO_BUNDLING, agentxEnv: "staging", agentxSynthesizer: "legacy" })).not.toThrow();
    } finally {
      if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
      else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
    }
  });
});

describe("outdir context (buildAgentXApp forwards it to `new App({ outdir })`)", () => {
  it("defaults to a fresh temporary directory when no outdir context is given, unchanged from before", () => {
    const first = buildAgentXApp({ ...NO_BUNDLING, agentxSynthesizer: "legacy", agentxEnv: "staging" });
    const second = buildAgentXApp({ ...NO_BUNDLING, agentxSynthesizer: "legacy", agentxEnv: "staging" });
    expect(first.outdir).toMatch(/cdk\.out/);
    expect(second.outdir).toMatch(/cdk\.out/);
    // Two apps built with no outdir context each get their own ephemeral directory: proof this is
    // still App's own default, not something buildAgentXApp now pins by accident.
    expect(first.outdir).not.toBe(second.outdir);
  });

  it("honors an explicit outdir context key", () => {
    const outdir = mkdtempSync(join(tmpdir(), "agentx-outdir-context-"));
    try {
      const app = buildAgentXApp({ ...NO_BUNDLING, agentxSynthesizer: "legacy", agentxEnv: "staging", outdir });
      expect(app.outdir).toBe(outdir);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
