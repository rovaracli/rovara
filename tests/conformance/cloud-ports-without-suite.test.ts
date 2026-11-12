// Convergence lane A9: Cloud adapters on Code ports that have no Code conformance suite yet (owed upstream, tests/conformance/owed-upstream.json). Until Code ships one, the port's
// documented rules are checked here against Cloud's adapter, typed as Code's port so a shape drift is a compile error.
import { describe, expect, it } from "vitest";
import type { CompanyInstructionsSource, OrgId } from "@rovara-code/contracts";
import { companyRulesSourceOver } from "../../packages/broker/src/company-rules/source.js";
import type { CompanyRulesStore } from "../../packages/broker/src/company-rules/store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
type Versions = Map<number, Array<{ text: string; priority: "required" | "preferred" }>>;

/** The two reads the adapter makes, over an in-memory list of approved versions (the newest is the head). */
function storeOf(versions: Versions, options: { lose?: number; fail?: boolean } = {}): CompanyRulesStore {
  const store = {
    async currentHead(orgId: OrgId) {
      if (options.fail === true) throw new Error("the table is down");
      return { latestVersion: orgId === ORG ? Math.max(0, ...versions.keys()) : 0, latestDigest: "" };
    },
    async version(_orgId: OrgId, version: number) {
      if (version === options.lose) return undefined;
      const rules = versions.get(version);
      return rules === undefined ? undefined : { version, rules };
    },
  };
  return store as unknown as CompanyRulesStore;
}

describe("company-instructions: Cloud's store adapter on Code's port", () => {
  const source = (versions: Versions, options?: { lose?: number; fail?: boolean }): CompanyInstructionsSource => companyRulesSourceOver(storeOf(versions, options));

  it("answers undefined for a company with no rules, and for a key that names no company", async () => {
    expect(await source(new Map()).current(ORG)).toBeUndefined();
    expect(await source(new Map([[1, [{ text: "Use pnpm.", priority: "required" }]]])).current("not-an-org")).toBeUndefined();
  });

  it("answers the newest approved version, and the version changes when the rules do", async () => {
    const versions: Versions = new Map([[1, [{ text: "Use pnpm.", priority: "required" }]]]);
    const first = await source(versions).current(ORG);
    expect(first).toEqual({ version: "1", rules: [{ text: "Use pnpm.", priority: "required" }] });
    versions.set(2, [{ text: "Use pnpm.", priority: "required" }, { text: "Prefer small changes.", priority: "preferred" }]);
    const second = await source(versions).current(ORG);
    expect(second?.version).not.toBe(first?.version);
    expect(second?.rules).toHaveLength(2);
  });

  it("rejects (the step fails closed) when the rules exist but cannot be read, never answering 'no rules'", async () => {
    await expect(source(new Map([[1, [{ text: "x", priority: "required" }]]]), { lose: 1 }).current(ORG)).rejects.toBeDefined();
    await expect(source(new Map(), { fail: true }).current(ORG)).rejects.toBeDefined();
  });
});
