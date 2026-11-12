// 0.5.15 signing-key lane: no Lambda variable carries the callback signing key, each function may read only the key secret(s) it needs, and
// CloudFormation never holds either secret (the deploy creates them outside every stack, so no update regenerates or overwrites a value and no
// stack deletion deletes one: stronger than RETAIN). The legacy install's frozen template is checked unchanged by legacy-templates.test.ts.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Resource: unknown; Effect: string };

const KEY_SECRETS = { callback: ":secret:agentx/staging/callback-signing-key-??????", erasure: ":secret:agentx/staging/erasure-hash-key-??????" } as const;

describe("the key secrets in a named environment's templates", () => {
  const templates = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .map((stack) => ({ name: stack.stackName, template: Template.fromStack(stack).toJSON() as { Parameters?: Record<string, Record<string, unknown>>; Resources: Record<string, Resource> } }));

  it("gives no Lambda function the callback signing key, or any reference to its parameter", () => {
    const functions = templates.flatMap(({ name, template }) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function").map(([id, resource]) => ({ name, id, resource })));
    // Positive control: the broker is among them.
    expect(functions.some(({ id }) => /^Broker[0-9A-F]{8}$/u.test(id))).toBe(true);
    for (const { name, id, resource } of functions) {
      const variables = ((resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables) ?? {};
      expect(Object.keys(variables), `${name}/${id}`).not.toContain("CALLBACK_SIGNING_KEY");
      expect(JSON.stringify(variables), `${name}/${id}`).not.toMatch(/CallbackSigningKey|signing-key|erasure-hash-key/u);
    }
  });

  it("declares no CallbackSigningKey parameter (dropped in 0.5.15 with the CLI's pass-through), and references it nowhere", () => {
    const controlPlane = templates.find(({ name }) => name === "agentx-staging-control-plane")!.template;
    // Positive control: the control plane does declare parameters, and it is the legacy install's frozen template (legacy-templates.test.ts) that keeps this one.
    expect(Object.keys(controlPlane.Parameters ?? {})).toContain("GitHubAppId");
    expect(controlPlane.Parameters).not.toHaveProperty("CallbackSigningKey");
    expect(JSON.stringify(controlPlane)).not.toContain("\"CallbackSigningKey\"");
    for (const { name, template } of templates) expect(Object.entries(template.Parameters ?? {}).filter(([, parameter]) => parameter.NoEcho === true), name).toEqual([]);
  });

  it("creates neither key secret in any stack", () => {
    for (const { template } of templates) {
      const secrets = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::SecretsManager::Secret");
      expect(JSON.stringify(secrets)).not.toMatch(/callback-signing-key|erasure-hash-key/u);
    }
  });

  it("lets exactly the broker read both, the eval tick and the reconciler the callback signing key alone, read-only", () => {
    const readers = new Map<string, Set<string>>();
    for (const { template } of templates) {
      const functionsByRole = new Map<string, string>();
      for (const [id, resource] of Object.entries(template.Resources)) {
        const role = (resource.Properties.Role as { "Fn::GetAtt"?: [string, string] } | undefined)?.["Fn::GetAtt"]?.[0];
        if (resource.Type === "AWS::Lambda::Function" && role !== undefined) functionsByRole.set(role, id.replace(/[0-9A-F]{8}$/u, ""));
      }
      for (const resource of Object.values(template.Resources)) {
        if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
        const statements = (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
        const roles = ((resource.Properties.Roles as Array<{ Ref?: string }> | undefined) ?? []).map((role) => role.Ref);
        for (const statement of statements) {
          // A statement may name NotResource instead (no Resource): it grants none of the key secrets by name.
          const text = JSON.stringify(statement.Resource) ?? "";
          for (const [kind, arn] of Object.entries(KEY_SECRETS)) {
            if (!text.includes(arn)) continue;
            expect([statement.Action].flat()).toEqual(["secretsmanager:GetSecretValue"]);
            expect(statement.Effect).toBe("Allow");
            for (const role of roles) {
              const fn = functionsByRole.get(role ?? "") ?? `role:${role}`;
              readers.set(fn, (readers.get(fn) ?? new Set()).add(kind));
            }
          }
          // No function's grant reads every secret, or every secret of the environment (which would cover the key secrets).
          const reads = [statement.Action].flat().some((action) => action === "secretsmanager:GetSecretValue" || action === "secretsmanager:*" || action === "*");
          if (reads && roles.some((role) => functionsByRole.has(role ?? ""))) expect(text, text).not.toMatch(/:secret:\*"|:secret:agentx\/staging\/\*"|"\*"/u);
        }
      }
    }
    expect(Object.fromEntries([...readers].map(([fn, kinds]) => [fn, [...kinds].sort()]))).toEqual({
      Broker: ["callback", "erasure"],
      EvalBatchTick: ["callback"],
      SessionsReconciler: ["callback"],
    });
  }, 240_000);
});
