// Meta repo lane B, task B3: the apply route against stub dependencies, for the paths the broker harness cannot reach: a setting the meta repo's config file manages, a
// deployment without approvals, and an error that must not be swallowed.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StoredProjectDefinitionSchema, agentXError, setupDraftKey, type AppProjectDetail, type SetupProposal, sanitizeSetupProposal } from "@agentx/contracts";
import { ManagedByFileError } from "../../packages/broker/src/org/project-settings.js";
import { applySetupDraft, type SetupDraftDependencies } from "../../packages/broker/src/rovara-code/setup-draft.js";
import { changeTitleOf } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { SETUP_ITEM_WORDS } from "../../packages/broker/src/rovara-code/setup-items.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { TEST_ORG } from "../support/orgs.js";

const COMMIT = "a".repeat(40);
const caller = { orgId: TEST_ORG, developerId: "e".repeat(64), name: "Omar", orgRole: "owner", sessionId: "s", amr: "oidc" } as unknown as DeveloperCaller;
const definition = StoredProjectDefinitionSchema.parse({
  name: "web", revision: 1,
  repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
});
const cite = (path: string) => ({ kind: "file", repo: "web", path, commit: COMMIT });
const read = sanitizeSetupProposal({
  setup: [{ repo: "web", commands: ["npm ci"], from: [cite("package.json")] }],
  tests: [{ repo: "web", commands: ["npm test"], from: [cite("package.json")] }],
  repositories: [{ name: "lib", url: "https://github.com/acme/lib", from: [cite("README.md")] }],
}, { basedOnRevision: 1, repositories: [{ name: "web" }] });
if (!read.ok) throw new Error("fixture");
const proposal: SetupProposal = read.proposal;

/** A tiny table: a get returns what was put; a transaction's puts and an update are kept. */
function stubDeps(overrides: Partial<SetupDraftDependencies> = {}): { deps: SetupDraftDependencies; puts: Array<Record<string, unknown>>; updateSettings: ReturnType<typeof vi.fn>; startSetupCheck: ReturnType<typeof vi.fn> } {
  const updateSettings = vi.fn(async () => ({ project: {} as AppProjectDetail, warnings: [] as string[] }));
  const startSetupCheck = vi.fn(async () => undefined);
  const taskId = randomUUID();
  const items = new Map<string, Record<string, unknown>>();
  const key = (k: { pk: string; sk: string }) => `${k.pk}|${k.sk}`;
  items.set(key(setupDraftKey(TEST_ORG, "web")), { ...setupDraftKey(TEST_ORG, "web"), entityType: "SETUP_DRAFT", orgId: TEST_ORG, project: "web", taskId, requestId: randomUUID(), requestedBy: caller.developerId, basedOnRevision: 1, startedAt: new Date().toISOString() });
  items.set(key({ pk: `DEVTASK#${taskId}`, sk: "META" }), { pk: `DEVTASK#${taskId}`, sk: "META", orgId: TEST_ORG, purpose: "setup_draft", taskId, workspaceId: randomUUID(), setupDraftResult: { status: "ready", proposal } });
  const puts: Array<Record<string, unknown>> = [];
  const documentClient = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: items.get(key(command.input["Key"] as { pk: string; sk: string })) };
      if (command.constructor.name === "TransactWriteCommand") for (const entry of command.input["TransactItems"] as Array<{ Put?: { Item: Record<string, unknown> } }>) if (entry.Put) puts.push(entry.Put.Item);
      return {};
    }),
  };
  const deps: SetupDraftDependencies = {
    documentClient, tableName: "state", now: () => Date.now(), starter: undefined,
    projectFor: async () => ({ name: "web", role: "maintainer" }),
    requireNewWork: async () => undefined,
    latest: async () => ({ revision: 1, allowedDomains: [], definition }),
    updateSettings, startSetupCheck,
    startPullRequest: vi.fn(async () => ({ taskId: randomUUID() })),
    readProject: async () => ({ name: "web" }) as unknown as AppProjectDetail,
    ...overrides,
  };
  return { deps, puts, updateSettings, startSetupCheck };
}
const body = (items: Array<{ id: string; useSuggestion?: boolean }>) => ({ requestId: randomUUID(), expectedRevision: 1, items });
const outcomes = (reply: { body: unknown }) => (reply.body as { results: Array<{ id: string; outcome: string; message?: string }> }).results;

describe("applying a proposal against stub dependencies", () => {
  it("says a setting the meta repo's config file manages is changed there, for each item in that save, and does not start a check", async () => {
    const { deps, startSetupCheck } = stubDeps({ updateSettings: vi.fn(async () => { throw new ManagedByFileError(["setup", "readiness"]); }) });
    const reply = await applySetupDraft(deps, caller, "web", body([{ id: "setup-web" }, { id: "tests-web" }]));
    expect(reply.statusCode).toBe(200);
    expect(outcomes(reply).map((entry) => [entry.id, entry.outcome, entry.message])).toEqual([
      ["setup-web", "managed_by_file", SETUP_ITEM_WORDS.managedByFile], ["tests-web", "managed_by_file", SETUP_ITEM_WORDS.managedByFile],
    ]);
    expect(startSetupCheck).not.toHaveBeenCalled();
    expect((reply.body as { setupCheck: string }).setupCheck).toBe("not_needed");
  });

  it("does not read the words of a refusal: the same sentence from any other source is the person's answer, not a managed-by-file outcome", async () => {
    const { deps } = stubDeps({ updateSettings: vi.fn(async () => { throw agentXError("FORBIDDEN", "readiness is managed by the meta repo's config file; change it there"); }) });
    await expect(applySetupDraft(deps, caller, "web", body([{ id: "setup-web" }]))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("makes every settings save as the setup agent, and tells the appliers' settings host to do the same", async () => {
    const { deps, updateSettings } = stubDeps();
    await applySetupDraft(deps, caller, "web", body([{ id: "setup-web" }]));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect((updateSettings.mock.calls[0] as unknown[])[3]).toEqual({ origin: "agent" });
  });

  it("does not hide any other refusal of the settings save: it is the person's answer", async () => {
    const { deps } = stubDeps({ updateSettings: vi.fn(async () => { throw agentXError("FORBIDDEN", "this project carries an end-to-end policy"); }) });
    await expect(applySetupDraft(deps, caller, "web", body([{ id: "setup-web" }]))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("makes no card where approvals are not set up, and says so", async () => {
    const { deps, puts, updateSettings } = stubDeps();
    const reply = await applySetupDraft(deps, caller, "web", body([{ id: "repo-https-github.com-acme-lib" }]));
    expect(outcomes(reply)).toEqual([{ id: "repo-https-github.com-acme-lib", kind: "repository", outcome: "not_available", message: SETUP_ITEM_WORDS.noCards }]);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(puts.some((item) => item["entityType"] === "APPROVAL")).toBe(false);
  });

  it("registers what confirming a card does: it records consent, takes an undecided record as no consent, and the page names it", async () => {
    const handler = getApprovalSubjectHandler("setup_item")!;
    expect(handler).toBeDefined();
    const record = { orgId: TEST_ORG, approvalId: "apr_x", kind: "change", subject: { kind: "setup_item", project: "web", draftTaskId: randomUUID(), itemId: "repo-x", itemKind: "repository", digest: "a".repeat(64) }, changes: [], approvers: { kind: "rule", rule: "org_admin", candidates: [] }, status: "APPROVED", requestedBy: "x", createdAt: "x", expiresAt: "x" };
    await expect(handler({} as never, record as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(handler({} as never, { ...record, decidedBy: "f".repeat(64) } as never)).resolves.toBeUndefined();
    expect(changeTitleOf("setup_item")).toBe("Approve a setup suggestion from Rovara");
  });
});
