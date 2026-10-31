import { describe, expect, it } from "vitest";
import { editionRecordName } from "../../packages/cli/src/deploy/edition.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { writeSignInSettings } from "../../packages/cli/src/signin/settings.js";
import { SSO_BOOTSTRAP_NEEDS_YES, type SsoBootstrapServices } from "../../packages/cli/src/sso/bootstrap.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { HOLDER, T0 } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

// Enterprise foundations I-5: `rovara sso bootstrap` (the first-run command) reads what the install recorded and calls the broker's bootstrap.

const ISSUER = "https://acme.okta.com";
const ARGS = ["--env", "staging", "sso", "bootstrap", "--admin-group", "rovara-admins", "--member-group", "rovara-users", "--owner-subject", "olga"];

async function world(options: { edition?: string | null; oidc?: boolean; account?: string } = {}) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, { ...stagingSettings, engine: "cdk", stacks: { ...stagingSettings.stacks, "control-plane": "agentx-staging-control-plane" } });
  if (options.edition !== null) store.values.set(editionRecordName("staging"), options.edition ?? "enterprise");
  if (options.oidc !== false) {
    await writeSignInSettings(store, { schemaVersion: 1, env: "staging", slack: false, oidc: { issuer: ISSUER, clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" }, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER });
  }
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db });
  const lines: string[] = [];
  const services: Partial<SsoBootstrapServices> = {
    store, identity: { get: async () => ({ account: options.account ?? "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Deploy/alice" }) },
    outputs: async () => ({ StateTableName: "state" }), documentClient: db, audit: () => capture.audit, write: (line) => lines.push(line), now: () => T0,
  };
  const run = async (args: string[]) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await executeCli(args, { stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) }, sso: services });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  };
  return { db, capture, lines, run };
}

describe("rovara sso bootstrap", () => {
  it("shows the plan and writes nothing without --yes", async () => {
    const w = await world();
    const result = await w.run(ARGS);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(SSO_BOOTSTRAP_NEEDS_YES);
    expect(w.lines.join("\n")).toContain("group rovara-admins -> admin");
    expect(w.db.find(() => true)).toEqual([]);
  });

  it("writes the first mapping, the owners and the emergency list with --yes, and refuses a second run", async () => {
    const w = await world();
    const result = await w.run([...ARGS, "--yes"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1 owner(s), 2 group rule(s)");
    expect(w.db.find((item) => item.sk === "SSO_GROUP_MAPPING")).toHaveLength(1);
    expect(w.db.find((item) => item.sk === "SSO_BREAK_GLASS")).toHaveLength(1);
    expect(w.capture.recorded().map((event) => event.action)).toEqual(expect.arrayContaining(["sso.group_mapping_changed", "sso.break_glass_changed"]));
    const again = await w.run([...ARGS, "--yes", "--owner-subject", "mallory"]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already set up");
  });

  it("is for a recorded Enterprise install with the company sign-in on, in the install's own account", async () => {
    for (const [options, text] of [[{ edition: null }, "not recorded as an Enterprise"], [{ edition: "public" }, "not recorded as an Enterprise"], [{ oidc: false }, "rovara signin enable oidc"], [{ account: "999999999999" }, "belong to account"]] as const) {
      const w = await world(options);
      const result = await w.run([...ARGS, "--yes"]);
      expect(result.code, JSON.stringify(options)).not.toBe(0);
      expect(result.stderr, JSON.stringify(options)).toContain(text);
      expect(w.db.find(() => true)).toEqual([]);
    }
  });
});
