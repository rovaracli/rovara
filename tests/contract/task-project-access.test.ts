import { slackBindingPk } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { evaluateProjectAuthority, readProjectAuthority, type ProjectAuthorityReader } from "../../packages/broker/src/developer/task-project-access.js";
import { DEFAULT_DEVELOPER_TASK_POLICY, developerTaskPolicy, type SlackChannelBinding } from "@rovara-code/contracts";
import { TEST_ORG } from "../support/orgs.js";
import { projectMemberKey, projectRevisionKey } from "@rovara-code/contracts";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";

const binding = (channelId: string, projectName = "payments-api"): SlackChannelBinding & { pk: string; sk: string } => ({
  pk: slackBindingPk(TEST_ORG, "T0BSHLLUGBD"), sk: `CHANNEL#${channelId}`,
  teamId: "T0BSHLLUGBD", channelId, projectName, updatedAt: "2026-01-01T00:00:00.000Z",
});
const revision = (definition: { developerTasks?: unknown }) => ({
  ...projectRevisionKey(TEST_ORG, "payments-api", 7), revision: 7, definition,
});
const developerGrant = { ...projectMemberKey(TEST_ORG, "a".repeat(64), "payments-api"), projectName: "payments-api", role: "developer" };

describe("task project authority core", () => {
  it("counts only developer memberships as project grants", () => {
    const result = evaluateProjectAuthority({
      orgId: TEST_ORG,
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({ developerTasks: { enabled: true, channelMembersMayUse: false } }),
      memberships: [{ ...developerGrant, role: "administrator" }],
      bindings: [],
      freshMemberOf: [],
      slackUserId: "U0123456789",
    });

    expect(result).toEqual({ kind: "denied", reason: "project-access", visibleChannelIds: [] });
  });

  it("allows a developer grant even without a Slack identity", () => {
    const result = evaluateProjectAuthority({
      orgId: TEST_ORG,
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({}),
      memberships: [developerGrant],
      bindings: [binding("C0123456789")],
    });

    expect(result).toMatchObject({ kind: "allowed", revision: 7, access: "granted", channelIds: ["C0123456789"] });
  });

  it("keeps task-policy denial after access has been established", () => {
    const result = evaluateProjectAuthority({
      orgId: TEST_ORG,
      project: "payments-api",
      revision: revision({ developerTasks: { enabled: false } }),
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      memberships: [developerGrant],
      bindings: [],
    });

    expect(result).toEqual({ kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] });
  });

  it("returns unavailable when any bounded read is incomplete", async () => {
    const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
    const reader: ProjectAuthorityReader = {
      latestRevision: vi.fn().mockResolvedValue({ revision: revision({}), complete: true }),
      memberships: vi.fn().mockResolvedValue({ items: [], complete: false }),
      bindings: vi.fn().mockResolvedValue({ items: [], complete: true }),
    };

    await expect(readProjectAuthority(reader, { orgId: TEST_ORG,
      project: "payments-api", developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      admission,
    })).resolves.toEqual({ kind: "unavailable" });
    expect(admission.remainingStateReads()).toBe(126);
  });

  it("uses fresh membership and leaves channel-name decoration outside the evaluator", () => {
    const result = evaluateProjectAuthority({
      orgId: TEST_ORG,
      project: "payments-api",
      developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({ developerTasks: { enabled: true, channelMembersMayUse: true } }),
      memberships: [],
      bindings: [binding("C0123456789")],
      freshMemberOf: ["C0123456789"],
      slackUserId: "U0123456789",
    });

    expect(result).toMatchObject({ kind: "allowed", access: "channel", channelIds: ["C0123456789"] });
    expect(result).not.toHaveProperty("name");
    expect(DEFAULT_DEVELOPER_TASK_POLICY.enabled).toBe(true);
    expect(developerTaskPolicy({ developerTasks: {} }).enabled).toBe(true);
  });

  describe("the org role (final review I1)", () => {
    const owner = { ...orgMemberKey(TEST_ORG, "a".repeat(64)), role: "owner" as const };
    const base = {
      orgId: TEST_ORG, project: "payments-api", developerId: "a".repeat(64), teamId: "T0BSHLLUGBD",
      revision: revision({}), bindings: [] as never[],
    };

    it("treats an org owner or admin with no grant as granted, with the org member row as the witness", () => {
      for (const role of ["owner", "admin"] as const) {
        const result = evaluateProjectAuthority({ ...base, memberships: [], orgMember: { ...owner, role } });
        expect(result).toMatchObject({ kind: "allowed", access: "granted", witness: { access: "granted", orgMember: { pk: owner.pk, sk: owner.sk, role } } });
        expect((result as { witness?: { membership?: unknown } }).witness?.membership).toBeUndefined();
      }
    });

    it("lets the org role beat a stale viewer grant, as the effective role does", () => {
      const result = evaluateProjectAuthority({ ...base, memberships: [{ ...developerGrant, role: "viewer" }], orgMember: owner });
      expect(result).toMatchObject({ kind: "allowed", access: "granted", witness: { orgMember: { role: "owner" } } });
    });

    it("keeps a plain member with no grant, and a viewer grant, as they were", () => {
      expect(evaluateProjectAuthority({ ...base, memberships: [], orgMember: { ...owner, role: "member" } }))
        .toEqual({ kind: "denied", reason: "project-access", visibleChannelIds: [] });
      expect(evaluateProjectAuthority({ ...base, memberships: [{ ...developerGrant, role: "viewer" }], orgMember: { ...owner, role: "member" } }))
        .toEqual({ kind: "denied", reason: "project-viewer", visibleChannelIds: [] });
    });

    it("refuses an org member row keyed in another org or for another developer", () => {
      expect(evaluateProjectAuthority({ ...base, memberships: [], orgMember: { ...orgMemberKey(TEST_ORG, "b".repeat(64)), role: "owner" } })).toEqual({ kind: "unavailable" });
    });

    it("still respects a project that turned tasks off", () => {
      const off = revision({ developerTasks: { enabled: false } });
      expect(evaluateProjectAuthority({ ...base, revision: off, memberships: [], orgMember: owner })).toEqual({ kind: "denied", reason: "tasks-disabled", visibleChannelIds: [] });
    });

    it("reads the org member through the reader and gives it to the evaluator", async () => {
      const orgMemberRead = vi.fn().mockResolvedValue({ item: owner, complete: true });
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const reader: ProjectAuthorityReader = {
        latestRevision: vi.fn().mockResolvedValue({ revision: revision({}), complete: true }),
        memberships: vi.fn().mockResolvedValue({ items: [], complete: true }),
        bindings: vi.fn().mockResolvedValue({ items: [], complete: true }),
        orgMember: orgMemberRead,
      };
      const result = await readProjectAuthority(reader, { orgId: TEST_ORG, project: "payments-api", developerId: "a".repeat(64), teamId: "T0BSHLLUGBD", admission });
      expect(result).toMatchObject({ kind: "allowed", access: "granted", witness: { orgMember: { role: "owner" } } });
      expect(orgMemberRead).toHaveBeenCalledWith(TEST_ORG, "a".repeat(64), admission, expect.anything());
    });

    it("fails closed when the org member read is incomplete", async () => {
      const admission = createTaskAuthorityAdmission({ now: () => 1_000, lambdaRemainingMs: 20_000 });
      const reader: ProjectAuthorityReader = {
        latestRevision: vi.fn().mockResolvedValue({ revision: revision({}), complete: true }),
        memberships: vi.fn().mockResolvedValue({ items: [], complete: true }),
        bindings: vi.fn().mockResolvedValue({ items: [], complete: true }),
        orgMember: vi.fn().mockResolvedValue({ complete: false }),
      };
      await expect(readProjectAuthority(reader, { orgId: TEST_ORG, project: "payments-api", developerId: "a".repeat(64), teamId: "T0BSHLLUGBD", admission }))
        .resolves.toEqual({ kind: "unavailable" });
    });
  });
});
