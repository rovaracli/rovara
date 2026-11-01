// v1.2 learning loop: withdrawing a suggestion (its sources went away) has its own audit action, `rule.withdrawn`, by the system with a fixed cause. `rule.dismissed` is for a person's Dismiss only.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { agentXError, orgMemberKey, orgProjectCatalogKey } from "../../packages/contracts/src/index.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { eraseLearningSubject } from "../../packages/broker/src/learning/cleanup.js";
import { acceptSuggestion, dismissSuggestion } from "../../packages/broker/src/learning/decide.js";
import { forgetCorrection, groupCorrections } from "../../packages/broker/src/learning/grouping.js";
import type { LearningDecideDeps } from "../../packages/broker/src/learning/settle.js";
import { signatureOf } from "../../packages/broker/src/learning/similarity.js";
import { learningSalt } from "../../packages/broker/src/learning/standing.js";
import { captureCorrection } from "../../packages/broker/src/learning/store.js";
import { ARJUN, MAX, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const SCOPE = { orgId: ORG_A, project: "web", projectCreatedAt: "2026-10-02T00:00:00.000Z" };
const RETRY_A = "Use the shared retry helper for network calls, with exponential backoff.";
const RETRY_B = "Use the shared retry helper for network calls, with exponential backoff and jitter on every attempt.";
const ROLES: Record<string, "admin" | "member"> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? ("member" as const) });

function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
const learning = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
const decideDeps = (w: MergeWorld): LearningDecideDeps => ({
  ...learning(w), store: w.store, approvals: w.deps,
  projectFor: async (caller: DeveloperCaller, rawName: string) => {
    const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
    if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
    return { name: rawName, role };
  },
});
const events = (w: MergeWorld, action: Parameters<MergeWorld["audit"]["recordedBy"]>[0]) => w.audit.recordedBy(action);

async function suggest(w: MergeWorld, source: "comment" | "pr_comment" = "comment"): Promise<string> {
  for (const [author, task, text] of [[PRIYA, "t1", RETRY_A], [ARJUN, "t2", RETRY_B]] as const) {
    w.clock.now += 1000;
    const result = await captureCorrection(learning(w), SCOPE, {
      id: `c${randomUUID().slice(0, 8)}`, stage: "build", source, sourceKey: `key-${randomUUID()}`, sourceRef: { taskId: task }, taskId: task, text,
      signature: [...signatureOf(text, learningSalt(SCOPE))], author, standing: "member", limit: source === "pr_comment" ? "automatic_pr" : "automatic",
    });
    expect(result).toMatchObject({ ok: true, created: true });
  }
  const grouped = await groupCorrections(learning(w), SCOPE, { prCaptureOff: async () => false });
  expect(grouped.opened).toHaveLength(1);
  return grouped.opened[0]!;
}

describe("rule.withdrawn", () => {
  const expectWithdrawn = (w: MergeWorld, id: string, cause: string) => {
    expect(events(w, "rule.withdrawn")).toEqual([expect.objectContaining({
      action: "rule.withdrawn", actor: { kind: "system", id: "rovara" }, target: { kind: "project", name: "web" }, facts: { suggestionId: id, stage: "build", cause },
    })]);
    expect(events(w, "rule.dismissed")).toEqual([]);
    expect(JSON.stringify(events(w, "rule.withdrawn"))).not.toContain("retry helper");
  };

  it("Forget that leaves too few sources: cause `forgotten`", async () => {
    const w = world();
    const id = await suggest(w);
    const one = w.db.find((entry) => String(entry.sk).startsWith("CORRECTION#"))[0]!;
    await forgetCorrection(learning(w), SCOPE, { correctionSk: String(one.sk), actor: PRIYA });
    expectWithdrawn(w, id, "forgotten");
  });

  it("Accept finding the sources gone: cause `sources_gone`", async () => {
    const w = world();
    const id = await suggest(w);
    w.db.delete(orgMemberKey(ORG_A, ARJUN));
    const item = w.db.find((entry) => entry.sk === `SUGGESTION#${id}`)[0]!;
    await acceptSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { requestId: randomUUID(), expectedRevision: Number(item.revision), stage: "build", text: "Use the shared retry helper." }).catch(() => undefined);
    expectWithdrawn(w, id, "sources_gone");
  });

  it("PR capture off taking the PR sources away: cause `pr_capture_off`", async () => {
    const w = world();
    const id = await suggest(w, "pr_comment");
    await groupCorrections(learning(w), SCOPE);
    expectWithdrawn(w, id, "pr_capture_off");
  });

  it("person erase taking a source away: cause `erased`", async () => {
    const w = world();
    const id = await suggest(w);
    w.db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web", orgId: ORG_A, latestRevision: 1 });
    expect(await eraseLearningSubject(learning(w), ORG_A, PRIYA)).toMatchObject({ status: "done" });
    expectWithdrawn(w, id, "erased");
  });

  it("a person's Dismiss is still rule.dismissed, and never rule.withdrawn", async () => {
    const w = world();
    const id = await suggest(w);
    await dismissSuggestion(decideDeps(w), callerOf(w, MAX), "web", id, { expectedRevision: 0, dismissKind: "one_off" });
    expect(events(w, "rule.dismissed")).toEqual([expect.objectContaining({ actor: expect.objectContaining({ id: MAX }) as unknown, facts: { suggestionId: id, stage: "build", dismissKind: "one_off" } })]);
    expect(events(w, "rule.withdrawn")).toEqual([]);
  });
});
