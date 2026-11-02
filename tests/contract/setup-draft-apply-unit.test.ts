// Meta repo lane B, task B3: the apply route against stub dependencies, for the paths the broker harness cannot reach: a setting the meta repo's config file manages, a
// deployment without approvals, and an error that must not be swallowed.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import { StoredProjectDefinitionSchema, agentXError, setupDraftKey, setupItemsOf as itemsOf, type AppProjectDetail, type SetupProposal, sanitizeSetupProposal } from "@agentx/contracts";
import { ManagedByFileError } from "../../packages/broker/src/org/project-settings.js";
import { applySetupDraft, type SetupDraftDependencies } from "../../packages/broker/src/rovara-code/setup-draft.js";
import { DRAFT_CHECK_WORDS, draftCommandLists, draftCommandsDigest, type SetupDraftCandidatePort } from "../../packages/broker/src/rovara-code/setup-draft-check.js";
import { changeTitleOf } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { SETUP_ITEM_WORDS, getSetupItemApplier } from "../../packages/broker/src/rovara-code/setup-items.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { TEST_ORG } from "../support/orgs.js";

const COMMIT = "a".repeat(40);
const caller = { orgId: TEST_ORG, developerId: "e".repeat(64), name: "Omar", orgRole: "owner", sessionId: "s", amr: "oidc", browserSession: true } as unknown as DeveloperCaller;
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

/** A candidate check that has passed for any of the lists these items make (TE-3): what a stored, recent, ready check of exactly those commands answers. */
const COMBINATIONS = [{ setupCommands: ["npm ci"] }, { testCommands: ["npm test"] }, { setupCommands: ["npm ci"], testCommands: ["npm test"] }];
type PortSpy = { read: SetupDraftCandidatePort["read"]; started: SetupDraftCandidatePort["started"]; start: Mock<SetupDraftCandidatePort["start"]>; adopt: Mock<SetupDraftCandidatePort["adopt"]> };
function passingCandidate(): PortSpy {
  return {
    read: async (_caller, _project, digest, current) => {
      const lists = COMBINATIONS.map((settings) => draftCommandLists(current, settings)).find((candidate) => draftCommandsDigest(candidate) === digest);
      const at = new Date().toISOString();
      return lists === undefined ? { check: undefined, setup: { status: "unchecked" } } : { check: { workspaceId: "w1", revision: current.revision, startedAt: at, ...lists }, setup: { status: "ready", checkedRevision: current.revision, checkedAt: at } };
    },
    started: async () => undefined,
    start: vi.fn<SetupDraftCandidatePort["start"]>(async () => undefined),
    adopt: vi.fn<SetupDraftCandidatePort["adopt"]>(async () => true),
  };
}

/** A tiny table: a get returns what was put; a transaction's puts and an update are kept. */
function stubDeps(overrides: Partial<SetupDraftDependencies> = {}): { deps: SetupDraftDependencies; puts: Array<Record<string, unknown>>; pointerUpdates: Array<Record<string, unknown>>; updateSettings: ReturnType<typeof vi.fn>; startSetupCheck: ReturnType<typeof vi.fn> } {
  const updateSettings = vi.fn(async () => ({ project: {} as AppProjectDetail, warnings: [] as string[] }));
  const startSetupCheck = vi.fn(async () => undefined);
  const taskId = randomUUID();
  const items = new Map<string, Record<string, unknown>>();
  const key = (k: { pk: string; sk: string }) => `${k.pk}|${k.sk}`;
  items.set(key(setupDraftKey(TEST_ORG, "web")), { ...setupDraftKey(TEST_ORG, "web"), entityType: "SETUP_DRAFT", orgId: TEST_ORG, project: "web", taskId, requestId: randomUUID(), requestedBy: caller.developerId, basedOnRevision: 1, startedAt: new Date().toISOString() });
  items.set(key({ pk: `DEVTASK#${taskId}`, sk: "META" }), { pk: `DEVTASK#${taskId}`, sk: "META", orgId: TEST_ORG, purpose: "setup_draft", taskId, workspaceId: randomUUID(), setupDraftResult: { status: "ready", proposal } });
  const puts: Array<Record<string, unknown>> = [];
  const pointerUpdates: Array<Record<string, unknown>> = [];
  const documentClient = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: items.get(key(command.input["Key"] as { pk: string; sk: string })) };
      if (command.constructor.name === "TransactWriteCommand") for (const entry of command.input["TransactItems"] as Array<{ Put?: { Item: Record<string, unknown> }; Update?: { ExpressionAttributeValues: Record<string, unknown> } }>) {
        if (entry.Put) puts.push(entry.Put.Item);
        if (entry.Update) pointerUpdates.push(entry.Update.ExpressionAttributeValues);
      }
      return {};
    }),
  };
  const deps: SetupDraftDependencies = {
    documentClient, tableName: "state", now: () => Date.now(), starter: undefined,
    projectFor: async () => ({ name: "web", role: "maintainer" }),
    requireNewWork: async () => undefined,
    latest: async () => ({ revision: 1, allowedDomains: [], definition }),
    updateSettings, startSetupCheck, candidate: passingCandidate(),
    startPullRequest: vi.fn(async () => ({ taskId: randomUUID() })),
    readProject: async () => ({ name: "web" }) as unknown as AppProjectDetail,
    ...overrides,
  };
  return { deps, puts, pointerUpdates, updateSettings, startSetupCheck };
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

  it("records the revision its own save made as the one the proposal follows, not whatever the table holds afterwards (a teammate's save in between)", async () => {
    let afterwards = false;
    const { deps, pointerUpdates } = stubDeps({
      updateSettings: vi.fn(async () => { afterwards = true; return { project: { latestRevision: 2 } as unknown as AppProjectDetail, warnings: [] }; }),
      latest: async () => ({ revision: afterwards ? 3 : 1, allowedDomains: [], definition }),
    });
    const reply = await applySetupDraft(deps, caller, "web", body([{ id: "setup-web" }]));
    expect(reply.statusCode).toBe(200);
    expect(pointerUpdates).toHaveLength(1);
    expect(pointerUpdates[0]).toMatchObject({ ":revision": 2 });
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

describe("the dev container pull request under one approval", () => {
  const withContainer = sanitizeSetupProposal({
    devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json", exists: false, proposedContent: "{\"image\":\"node:22\"}", from: [cite("package.json")] },
  }, { basedOnRevision: 1, repositories: [{ name: "web" }] });
  if (!withContainer.ok) throw new Error("fixture");

  // The "same request id on every press, so a retry after a lost reply opens no second pull request" case runs through the real route: rovara-code-setup-draft.test.ts (MB-7).

  it("derives different pull request ids for different approvals", async () => {
    const applier = getSetupItemApplier("devcontainer")!;
    const item = itemsOf(withContainer.proposal).find((entry) => entry.kind === "devcontainer")!;
    const ids: string[] = [];
    for (const approvalId of ["apr_a", "apr_b"]) {
      await applier.apply({
        project: "web", taskId: "t", item, proposal: withContainer.proposal, approvedBy: "admin", approvalId, requestId: "same-press", revision: 1,
        host: { updateSettings: async () => ({ warnings: [] }), startPullRequest: async ({ requestId }) => { ids.push(requestId); return { taskId: randomUUID() }; }, claimPullRequest: async () => undefined, releasePullRequestClaim: async () => undefined, addIntakeSource: async () => "added", connectionExists: async () => false },
      });
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("the commands are saved only after a passing check of exactly those commands (TE-3)", () => {
  const both = [{ id: "setup-web", useSuggestion: true }, { id: "tests-web", useSuggestion: true }];
  const ALL = { setupCommands: ["npm ci"], testCommands: ["npm test"] };
  const lists = draftCommandLists(definition, ALL);
  const ready = (over: Record<string, unknown> = {}, status: Record<string, unknown> = {}): SetupDraftCandidatePort["read"] => async () => {
    const at = new Date().toISOString();
    return { check: { workspaceId: "w1", revision: 1, startedAt: at, ...lists, ...over }, setup: { status: "ready", checkedRevision: 1, checkedAt: at, ...status } } as never;
  };
  const port = (over: Partial<SetupDraftCandidatePort> = {}): PortSpy =>
    ({ read: ready(), started: async () => undefined, start: vi.fn<SetupDraftCandidatePort["start"]>(async () => undefined), adopt: vi.fn<SetupDraftCandidatePort["adopt"]>(async () => true), ...over }) as never;
  const savesNothing = (updateSettings: ReturnType<typeof vi.fn>, startSetupCheck: ReturnType<typeof vi.fn>) => { expect(updateSettings).not.toHaveBeenCalled(); expect(startSetupCheck).not.toHaveBeenCalled(); };

  it("saves the commands when the check passed for exactly them at this revision, and passes the save the strings the check ran", async () => {
    const candidate = port();
    const { deps, updateSettings, startSetupCheck } = stubDeps({ candidate });
    const reply = await applySetupDraft(deps, caller, "web", body(both));
    expect(outcomes(reply).map((entry) => entry.outcome)).toEqual(["applied", "applied"]);
    expect(candidate.start).not.toHaveBeenCalled();
    expect((updateSettings.mock.calls[0] as unknown[])[2]).toMatchObject({ expectedRevision: 1, setupCommands: ["npm ci"], testCommands: ["npm test"] });
    // The passed check stands for the project's own check; a second one is not started.
    expect(candidate.adopt).toHaveBeenCalledTimes(1);
    expect(startSetupCheck).not.toHaveBeenCalled();
    expect((reply.body as { setupCheck: string }).setupCheck).toBe("not_needed");
  });

  it("a deployment with no candidate check saves no commands and says so (it fails closed, it does not save unchecked)", async () => {
    const { deps, updateSettings, startSetupCheck, puts } = stubDeps({ candidate: undefined });
    const reply = await applySetupDraft(deps, caller, "web", body(both));
    expect(reply.statusCode).toBe(200);
    expect(outcomes(reply).map((entry) => [entry.outcome, entry.message])).toEqual([["not_available", DRAFT_CHECK_WORDS.unavailable], ["not_available", DRAFT_CHECK_WORDS.unavailable]]);
    savesNothing(updateSettings, startSetupCheck);
    expect(puts).toEqual([]);
  });

  it("a worker or deployment that cannot run setup checks (the start is NOT_FOUND) is the same fail-closed answer", async () => {
    const candidate = port({ read: async () => ({ check: undefined, setup: { status: "unchecked" } }), start: vi.fn<SetupDraftCandidatePort["start"]>(async () => { throw agentXError("NOT_FOUND", "setup checks are not set up in this deployment"); }) });
    const { deps, updateSettings, startSetupCheck } = stubDeps({ candidate });
    const reply = await applySetupDraft(deps, caller, "web", body(both));
    expect(outcomes(reply).map((entry) => [entry.outcome, entry.message])).toEqual([["not_available", DRAFT_CHECK_WORDS.unavailable], ["not_available", DRAFT_CHECK_WORDS.unavailable]]);
    savesNothing(updateSettings, startSetupCheck);
  });

  it("is a browser's: a token (no browser session) is refused for commands before anything is read or started", async () => {
    const read = vi.fn(async () => ({ check: undefined, setup: { status: "unchecked" as const } }));
    const candidate = port({ read });
    const { deps, updateSettings, startSetupCheck } = stubDeps({ candidate });
    const token = { ...caller, browserSession: undefined } as unknown as DeveloperCaller;
    await expect(applySetupDraft(deps, token, "web", body(both))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(read).not.toHaveBeenCalled();
    expect(candidate.start).not.toHaveBeenCalled();
    savesNothing(updateSettings, startSetupCheck);
  });

  it("does not take a check at another revision, another list pair, an old one or a damaged one for these commands: it starts one and saves nothing", async () => {
    for (const [name, read] of [
      ["another revision", ready({ revision: 0 })],
      ["other commands", ready({ setup: [{ ...lists.setup[0]!, args: ["install"] }] })],
      ["other timeout", ready({ readiness: [{ ...lists.readiness[0]!, timeoutSeconds: 1 }] })],
      ["env that was not saved", ready({ setup: [{ ...lists.setup[0]!, env: { A: "1" } }] })],
      ["too old", ready({ startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })],
      ["a check that was never recorded", async () => ({ check: undefined, setup: { status: "unchecked" } }) as never],
      ["a check of an older revision's settings", ready({}, { status: "outdated" })],
    ] as Array<[string, SetupDraftCandidatePort["read"]]>) {
      const candidate = port({ read });
      const { deps, updateSettings, startSetupCheck } = stubDeps({ candidate });
      const reply = await applySetupDraft(deps, caller, "web", body(both));
      expect(outcomes(reply).map((entry) => entry.outcome), name).toEqual(["checking", "checking"]);
      expect(candidate.start, name).toHaveBeenCalledTimes(1);
      expect((candidate.start.mock.calls[0] as unknown[])[2], name).toMatchObject({ digest: draftCommandsDigest(lists), lists, expectedRevision: 1 });
      savesNothing(updateSettings, startSetupCheck);
    }
  });

  it("says a check that this request started and that is gone, or no longer matches, no longer applies; it does not start another under the same request", async () => {
    const candidate = port({ read: ready({ setup: [] }), started: async () => ({ workspaceId: "w1" }) });
    const { deps, updateSettings, startSetupCheck } = stubDeps({ candidate });
    const reply = await applySetupDraft(deps, caller, "web", body(both));
    expect(outcomes(reply).map((entry) => [entry.outcome, entry.message])).toEqual([["check_failed", DRAFT_CHECK_WORDS.lost], ["check_failed", DRAFT_CHECK_WORDS.lost]]);
    expect(candidate.start).not.toHaveBeenCalled();
    savesNothing(updateSettings, startSetupCheck);
  });

  it("waits for a check that runs (any request), shows a failure of the one this request started, and runs a new check after a failure it did not start", async () => {
    const state = (status: Record<string, unknown>): SetupDraftCandidatePort["read"] => async () => ({ check: { workspaceId: "w1", revision: 1, startedAt: new Date().toISOString(), ...lists }, setup: { checkedRevision: 1, checkedAt: new Date().toISOString(), ...status } }) as never;
    const running = port({ read: state({ status: "checking" }) });
    const waiting = stubDeps({ candidate: running });
    expect(outcomes(await applySetupDraft(waiting.deps, caller, "web", body(both))).map((entry) => entry.outcome)).toEqual(["checking", "checking"]);
    expect(running.start).not.toHaveBeenCalled();
    savesNothing(waiting.updateSettings, waiting.startSetupCheck);

    const mine = port({ read: state({ status: "failed", failedStep: "setup: npm ci - exited 1" }), started: async () => ({ workspaceId: "w1" }) });
    const shown = stubDeps({ candidate: mine });
    const failed = await applySetupDraft(shown.deps, caller, "web", body(both));
    expect(outcomes(failed).map((entry) => entry.outcome)).toEqual(["check_failed", "check_failed"]);
    expect((failed.body as { results: Array<{ reason?: string }> }).results.map((entry) => entry.reason)).toEqual(["setup: npm ci - exited 1", "setup: npm ci - exited 1"]);
    expect(mine.start).not.toHaveBeenCalled();
    savesNothing(shown.updateSettings, shown.startSetupCheck);

    // A press by another request shows the same failure and starts nothing; only an explicit "check again" starts a new check.
    const fresh = port({ read: state({ status: "failed", failedStep: "setup: npm ci - exited 1" }) });
    const shownAgain = stubDeps({ candidate: fresh });
    expect(outcomes(await applySetupDraft(shownAgain.deps, caller, "web", body(both))).map((entry) => entry.outcome)).toEqual(["check_failed", "check_failed"]);
    expect(fresh.start).not.toHaveBeenCalled();
    savesNothing(shownAgain.updateSettings, shownAgain.startSetupCheck);
    const again = stubDeps({ candidate: fresh });
    expect(outcomes(await applySetupDraft(again.deps, caller, "web", { ...body(both), checkAgain: true })).map((entry) => entry.outcome)).toEqual(["checking", "checking"]);
    expect(fresh.start).toHaveBeenCalledTimes(1);
    savesNothing(again.updateSettings, again.startSetupCheck);
  });

  it("a check that cannot start is shown with its reason and saves nothing; an archived project or a moved revision is said as it is", async () => {
    const unread: SetupDraftCandidatePort["read"] = async () => ({ check: undefined, setup: { status: "unchecked" } });
    const limited = port({ read: unread, start: vi.fn<SetupDraftCandidatePort["start"]>(async () => { throw agentXError("WORKSPACE_LIMIT", "you have reached the limit of 3 open workspaces per person"); }) });
    const first = stubDeps({ candidate: limited });
    const reply = await applySetupDraft(first.deps, caller, "web", body(both));
    expect(outcomes(reply).map((entry) => [entry.outcome, entry.message])).toEqual([["check_failed", DRAFT_CHECK_WORDS.notStarted], ["check_failed", DRAFT_CHECK_WORDS.notStarted]]);
    expect((reply.body as { results: Array<{ reason?: string }> }).results[0]!.reason).toContain("limit of 3 open workspaces");
    savesNothing(first.updateSettings, first.startSetupCheck);
    for (const code of ["PROJECT_ARCHIVED", "PROJECT_REVISION_MISMATCH"] as const) {
      const refused = stubDeps({ candidate: port({ read: unread, start: vi.fn<SetupDraftCandidatePort["start"]>(async () => { throw agentXError(code, "x"); }) }) });
      await expect(applySetupDraft(refused.deps, caller, "web", body(both))).rejects.toMatchObject({ code });
      savesNothing(refused.updateSettings, refused.startSetupCheck);
    }
    const busy = stubDeps({ candidate: port({ read: unread, start: vi.fn<SetupDraftCandidatePort["start"]>(async () => { throw agentXError("WORKSPACE_BUSY", "a setup check is already running for this project"); }) }) });
    expect(outcomes(await applySetupDraft(busy.deps, caller, "web", body(both))).map((entry) => entry.outcome)).toEqual(["checking", "checking"]);
    savesNothing(busy.updateSettings, busy.startSetupCheck);
  });

  it("a revision race after the check passed is refused by the save itself: nothing is recorded as applied", async () => {
    const { deps, puts, pointerUpdates } = stubDeps({
      candidate: port(),
      updateSettings: vi.fn(async () => { throw agentXError("PROJECT_REVISION_MISMATCH", "someone changed this project's settings; reload and try again"); }),
    });
    await expect(applySetupDraft(deps, caller, "web", body(both))).rejects.toMatchObject({ code: "PROJECT_REVISION_MISMATCH" });
    expect(puts).toEqual([]);
    expect(pointerUpdates).toEqual([]);
  });

  it("a request that waits for its check is not recorded, so its repeat goes on from where the check stands", async () => {
    const candidate = port({ read: async () => ({ check: undefined, setup: { status: "unchecked" } }) });
    const { deps, puts, pointerUpdates } = stubDeps({ candidate });
    await applySetupDraft(deps, caller, "web", body(both));
    expect(puts).toEqual([]);
    expect(pointerUpdates).toEqual([]);
  });
});

describe("the follow-up check after a save (TE-3)", () => {
  it("starts the project's own check when the passed check could not be adopted, or was too old", async () => {
    const old = passingCandidate();
    const read = old.read;
    old.read = async (...args) => { const state = await read(...args); return state.check === undefined ? state : { ...state, check: { ...state.check, startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } }; };
    const first = stubDeps({ candidate: old });
    const reply = await applySetupDraft(first.deps, caller, "web", body([{ id: "setup-web", useSuggestion: true }]));
    expect(outcomes(reply)[0]!.outcome).toBe("applied");
    expect(old.adopt).not.toHaveBeenCalled();
    expect(first.startSetupCheck).toHaveBeenCalledTimes(1);

    const refused = passingCandidate();
    refused.adopt.mockResolvedValue(false);
    const second = stubDeps({ candidate: refused });
    await applySetupDraft(second.deps, caller, "web", body([{ id: "setup-web", useSuggestion: true }]));
    expect(refused.adopt).toHaveBeenCalledTimes(1);
    expect(second.startSetupCheck).toHaveBeenCalledTimes(1);
  });
});
