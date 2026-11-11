// Rovara Code (Plan 6 Task 14): check and status deliveries only nudge. They are verified, matched to a task by the commit or the Rovara branch, bound to the org of the
// installation and to the task's pinned repository, deduplicated, and they only wake the task's tracking row; a forged or unmatched one changes nothing.
import { createHmac, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { githubInstallationKey } from "../../packages/cloud-contracts/src/org-node.js";
import { handleGithubWebhook, receiveGithubWebhook, GithubWebhookRefusal, type HeadWebhookEvent } from "../../packages/broker/src/aws/github-webhooks.js";
import { trackingRecoveryItem, mergeRecoveryItem } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { boundInstallationOrg, prHeadItems, resolveHeadEventTask, wakeFromHeadEvent, type HeadEventDependencies } from "../../packages/broker/src/rovara-code/tracking-events.js";
import { HEAD_A, HEAD_B, NOW, TABLE, TASK_ID, sha, world, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

const SECRET = "webhook-secret";
const INSTALLATION = 777;
const REPOSITORY = 1234;
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as typeof TEST_ORG;
const BRANCH = "agentx/9c0f0d9e-0000-4000-8000-000000000001";
const sign = (body: string, secret = SECRET): string => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const row = (w: TrackingWorld) => w.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${TASK_ID}`)!;

interface Setup { w: TrackingWorld; deps: HeadEventDependencies; verify: ReturnType<typeof vi.fn> }

async function setup(options: { kindlessRow?: boolean; installationOrg?: string; installationStatus?: string } = {}): Promise<Setup> {
  const w = world();
  w.db.set({ ...githubInstallationKey(INSTALLATION), entityType: "GITHUB_INSTALLATION", orgId: options.installationOrg ?? TEST_ORG, status: options.installationStatus ?? "active" });
  for (const key of [...w.db.items.keys()]) if (key.includes("WORKFLOW_MERGE_RECOVERY")) w.db.items.delete(key);
  await w.db.send(new TransactWriteCommand({ TransactItems: [
    (options.kindlessRow === true ? mergeRecoveryItem : trackingRecoveryItem)(TABLE, TASK_ID, new Date(NOW + 15 * 60_000).toISOString()),
    ...prHeadItems(TABLE, { orgId: TEST_ORG, repositoryFullName: "acme/payments", headSha: HEAD_A, taskId: TASK_ID, repositoryId: "payments", number: 7, branch: BRANCH }, NOW),
  ] }));
  const verify = vi.fn(async (_url: string, scope: { installationId: number; repositoryId: number; fullName: string }) =>
    scope.installationId === INSTALLATION && scope.repositoryId === REPOSITORY && scope.fullName === "acme/payments");
  const deps: HeadEventDependencies = {
    documentClient: w.db, tableName: TABLE, now: () => w.now(), loadTask: (id) => w.deps.loadTask(id), repositoryUrl: (...args) => w.deps.repositoryUrl(...args), verifyRepository: verify,
    orgOfInstallation: (id) => boundInstallationOrg({ documentClient: w.db, tableName: TABLE }, id),
  };
  return { w, deps, verify };
}

const repository = { id: REPOSITORY, full_name: "Acme/Payments" };
const checkRun = (head = HEAD_A, extra: Record<string, unknown> = {}) => ({ action: "completed", installation: { id: INSTALLATION }, repository, check_run: { head_sha: head, check_suite: { head_branch: null } }, ...extra });
const checkSuite = (head: string, branch: string | null) => ({ action: "completed", installation: { id: INSTALLATION }, repository, check_suite: { head_sha: head, head_branch: branch, pull_requests: [] } });
const statusEvent = (head: string, branches: string[] = []) => ({ state: "success", sha: head, installation: { id: INSTALLATION }, repository, branches: branches.map((name) => ({ name })) });

async function deliver(s: Setup, name: string, payload: unknown, options: { secret?: string; deliveryId?: string } = {}) {
  const body = JSON.stringify(payload);
  const processed: HeadWebhookEvent[] = [];
  const outcome = await handleGithubWebhook({
    documentClient: s.w.db, tableName: TABLE, rawBody: body,
    headers: { "x-hub-signature-256": sign(body, options.secret), "x-github-delivery": options.deliveryId ?? randomUUID(), "x-github-event": name },
    secret: SECRET,
    authorizeRepository: async (scope) => "headSha" in scope && await resolveHeadEventTask(s.deps, { ...scope, ...(scope.branch === undefined ? {} : { branch: scope.branch }) }) !== undefined,
    process: async (event) => {
      if (event.kind !== "HEAD_STATUS") throw new Error("only head events here");
      processed.push(event);
      await wakeFromHeadEvent(s.deps, event);
    },
    now: () => new Date(s.w.now()).toISOString(),
  });
  return { outcome, processed };
}

describe("a check or status delivery", () => {
  it("wakes the task's tracking row, found by the commit", async () => {
    const s = await setup();
    const { outcome, processed } = await deliver(s, "check_run", checkRun());
    expect(outcome.status).toBe("ACCEPTED");
    expect(processed).toEqual([{ kind: "HEAD_STATUS", action: "completed", installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A }]);
    expect(row(s.w)).toMatchObject({ wakeAt: NOW, nextAttemptAt: NOW + 30_000 });
  });

  it("finds the task of a status event that carries only a commit, and of a check_suite with no pull requests through its Rovara branch", async () => {
    const byCommit = await setup();
    expect((await deliver(byCommit, "status", statusEvent(HEAD_A))).processed).toHaveLength(1);
    const byBranch = await setup();
    const { outcome, processed } = await deliver(byBranch, "check_suite", checkSuite(sha("e"), BRANCH));
    expect(outcome.status).toBe("ACCEPTED");
    expect(processed[0]).toMatchObject({ headSha: sha("e"), branch: BRANCH });
    expect(row(byBranch.w).wakeAt).toBe(NOW);
    const statusBranch = await setup();
    expect((await deliver(statusBranch, "status", statusEvent(sha("f"), ["main", BRANCH]))).processed).toHaveLength(1);
  });

  it("answers IGNORED for a commit or branch no task follows, and reserves nothing", async () => {
    const s = await setup();
    for (const [name, payload] of [
      ["check_run", checkRun(sha("9"))],
      ["check_suite", checkSuite(sha("9"), "feature/unrelated")],
      ["check_suite", checkSuite(sha("9"), null)],
      ["status", statusEvent(sha("9"), ["main"])],
      ["check_run", { ...checkRun(), check_run: { head_sha: "not-a-commit" } }],
      ["check_run", { action: "completed" }],
    ] as const) {
      expect((await deliver(s, name, payload)).outcome.status).toBe("IGNORED");
    }
    expect(s.w.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#"))).toEqual([]);
    expect(row(s.w).wakeAt).toBeUndefined();
  });

  it("does not follow a branch name that is not Rovara's, or one the index cannot hold", async () => {
    const s = await setup();
    expect((await deliver(s, "check_suite", checkSuite(sha("9"), "agentx/has#hash"))).outcome.status).toBe("IGNORED");
    expect((await deliver(s, "check_suite", checkSuite(sha("9"), "main"))).outcome.status).toBe("IGNORED");
  });

  it("refuses a forged delivery (a signature that is not the secret's over the body) and writes nothing", async () => {
    const s = await setup();
    await expect(deliver(s, "check_run", { ...checkRun(), check_run: { head_sha: HEAD_A, conclusion: "success" } }, { secret: "wrong" })).rejects.toThrow(GithubWebhookRefusal);
    expect(s.w.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#"))).toEqual([]);
    expect(row(s.w).wakeAt).toBeUndefined();
    // A forged event claiming success changes nothing even when signed: the body decides nothing, the tracking pass reads GitHub.
    const { processed } = await deliver(s, "check_run", { ...checkRun(), check_run: { head_sha: HEAD_A, conclusion: "success", status: "completed" } });
    expect(processed).toHaveLength(1);
    expect(processed[0]).not.toHaveProperty("conclusion");
  });

  it("is processed once when GitHub redelivers it, and a reused delivery id with other content is refused", async () => {
    const s = await setup();
    const id = randomUUID();
    const first = await deliver(s, "check_run", checkRun(), { deliveryId: id });
    const again = await deliver(s, "check_run", checkRun(), { deliveryId: id });
    expect(first.outcome.status).toBe("ACCEPTED");
    expect(again.outcome.status).toBe("DUPLICATE");
    expect(again.processed).toEqual([]);
    await expect(deliver(s, "check_run", checkRun(HEAD_A, { action: "created" }), { deliveryId: id })).rejects.toThrow(/reused/);
  });

  it("takes twenty deliveries for one commit as one wake: the row's time is set once and never later", async () => {
    const s = await setup();
    let first: number | undefined;
    for (let delivery = 0; delivery < 20; delivery += 1) {
      s.w.setNow(NOW + delivery * 100);
      await deliver(s, "check_run", checkRun());
      first ??= row(s.w).nextAttemptAt as number;
      expect(row(s.w).nextAttemptAt).toBe(first);
    }
    expect(first).toBe(NOW + 30_000);
  });

  it("is refused across orgs: an installation bound to another org, an unbound one, or an index lead of another org's find no task", async () => {
    const other = await setup({ installationOrg: OTHER_ORG });
    expect((await deliver(other, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    const inactive = await setup({ installationStatus: "suspended" });
    expect((await deliver(inactive, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    // The lead names the org it was written for; a lead found under the right key but naming another org is not believed.
    const s = await setup();
    const key = prHeadItems(TABLE, { orgId: TEST_ORG, repositoryFullName: "acme/payments", headSha: HEAD_B, taskId: TASK_ID, repositoryId: "payments", number: 7 }, NOW)[0]!.Put!.Item!;
    s.w.db.set({ ...key, orgId: OTHER_ORG });
    expect((await deliver(s, "check_run", checkRun(HEAD_B))).outcome.status).toBe("IGNORED");
    // A task of another org behind a lead of this one.
    const crossed = await setup();
    crossed.w.setTask({ orgId: OTHER_ORG });
    expect((await deliver(crossed, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    expect(row(crossed.w).wakeAt).toBeUndefined();
  });

  it("is ignored when the pull request's link names another task", async () => {
    const s = await setup();
    s.w.db.set({ ...s.w.db.get("GITHUB_PR#acme/payments", "PR#0000000007")!, taskId: "00000000-0000-4000-8000-0000000000b2" });
    expect((await deliver(s, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    expect(row(s.w).wakeAt).toBeUndefined();
  });

  it("is refused for a repository the task's project does not pin through this installation", async () => {
    const s = await setup();
    s.verify.mockResolvedValue(false);
    expect((await deliver(s, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    const wrongRepository = await setup();
    expect((await deliver(wrongRepository, "check_run", { ...checkRun(), repository: { id: 9999, full_name: "Acme/Payments" } })).outcome.status).toBe("IGNORED");
    const wrongName = await setup();
    expect((await deliver(wrongName, "check_run", { ...checkRun(), repository: { id: REPOSITORY, full_name: "Acme/Other" } })).outcome.status).toBe("IGNORED");
  });

  it("ignores a task that is closed, finished, a version 1 task, or whose workflow no longer holds the pull request", async () => {
    for (const change of ["closed", "finished", "other pull request"]) {
      const s = await setup();
      if (change === "closed") s.w.setTask({ closedAt: "2026-10-25T10:00:00.000Z" });
      else if (change === "finished") s.w.setWorkflow({ stage: "MERGED", state: "COMPLETE" });
      else s.w.setWorkflow({ pullRequests: [{ repositoryId: "payments", number: 99, url: "https://github.com/acme/payments/pull/99", headSha: HEAD_A, candidateDigest: "c".repeat(64), required: true, state: "OPEN" }] });
      expect((await deliver(s, "check_run", checkRun())).outcome.status).toBe("IGNORED");
    }
    const v1 = await setup({ kindlessRow: true });
    v1.w.setWorkflow({ definitionVersion: "1.0.0" });
    expect((await deliver(v1, "check_run", checkRun())).outcome.status).toBe("IGNORED");
  });

  it("leaves a version 1 task's kind-less row exactly as it was, even if its delivery is processed", async () => {
    const s = await setup({ kindlessRow: true });
    const before = structuredClone(row(s.w));
    await wakeFromHeadEvent(s.deps, { kind: "HEAD_STATUS", action: "completed", installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A });
    expect(row(s.w)).toEqual(before);
  });

  it("asks the App about the repository once for a delivery: at receive, not again when the delivery is processed", async () => {
    const s = await setup();
    await deliver(s, "check_run", checkRun());
    expect(s.verify).toHaveBeenCalledTimes(1);
    // The recovery sweep checks again before it retries a delivery: the resolver does, when asked to.
    s.verify.mockClear();
    const event = { installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A };
    expect(await resolveHeadEventTask(s.deps, event)).toBeDefined();
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(await resolveHeadEventTask(s.deps, event, { verifyRepository: false })).toBeDefined();
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it("still compares the project's pinned repository by name when the App's check is skipped", async () => {
    const s = await setup();
    const url = s.deps.repositoryUrl.bind(s.deps);
    s.deps.repositoryUrl = async (...args) => (await url(...args))?.replace("payments", "other");
    expect(await resolveHeadEventTask(s.deps, { installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A }, { verifyRepository: false })).toBeUndefined();
  });

  it("creates no recovery row for a task that has none", async () => {
    const s = await setup();
    for (const key of [...s.w.db.items.keys()]) if (key.includes("WORKFLOW_MERGE_RECOVERY")) s.w.db.items.delete(key);
    expect(await wakeFromHeadEvent(s.deps, { kind: "HEAD_STATUS", action: "completed", installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A })).toBe("none");
    expect(s.w.db.find((item) => item.pk === "WORKFLOW_MERGE_RECOVERY")).toEqual([]);
  });
});

describe("the event as received", () => {
  it("asks the caller to authorize the commit, not a pull request number, and reserves the head event", async () => {
    const body = JSON.stringify(checkRun());
    const seen: unknown[] = [];
    const reserved: unknown[] = [];
    const received = await receiveGithubWebhook({
      rawBody: body, secret: SECRET,
      headers: { "x-hub-signature-256": sign(body), "x-github-delivery": randomUUID(), "x-github-event": "check_run" },
      authorizeRepository: async (scope) => { seen.push(scope); return true; },
      reserveDelivery: async (delivery) => { reserved.push(delivery.event); return "reserved"; },
    });
    expect(seen).toEqual([{ installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", headSha: HEAD_A }]);
    expect(received.event).toMatchObject({ kind: "HEAD_STATUS", headSha: HEAD_A });
    expect(reserved).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("pullRequestNumber");
  });

  it("never asks the caller about a delivery that names no commit", async () => {
    const authorize = vi.fn(async () => true);
    for (const sha of ["", "short", "A".repeat(40), `${"a".repeat(39)}#`]) {
      const body = JSON.stringify({ action: "completed", installation: { id: INSTALLATION }, repository, check_run: { head_sha: sha } });
      await expect(receiveGithubWebhook({
        rawBody: body, secret: SECRET, headers: { "x-hub-signature-256": sign(body), "x-github-delivery": randomUUID(), "x-github-event": "check_run" },
        authorizeRepository: authorize, reserveDelivery: async () => "reserved",
      })).rejects.toMatchObject({ name: "GithubWebhookIgnorable" });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it("still reads pull request events by their number", async () => {
    const body = JSON.stringify({ action: "synchronize", installation: { id: INSTALLATION }, repository, pull_request: { number: 7, head: { sha: HEAD_B } } });
    const seen: unknown[] = [];
    await receiveGithubWebhook({
      rawBody: body, secret: SECRET,
      headers: { "x-hub-signature-256": sign(body), "x-github-delivery": randomUUID(), "x-github-event": "pull_request" },
      authorizeRepository: async (scope) => { seen.push(scope); return true; },
      reserveDelivery: async () => "reserved",
    });
    expect(seen).toEqual([{ installationId: INSTALLATION, repositoryId: REPOSITORY, fullName: "acme/payments", pullRequestNumber: 7 }]);
  });
});

describe("the installation's org", () => {
  it("is the org an active binding names, read fresh, and nothing for a missing, suspended or malformed one", async () => {
    const w = world();
    const deps = { documentClient: w.db, tableName: TABLE };
    expect(await boundInstallationOrg(deps, INSTALLATION)).toBeUndefined();
    w.db.set({ ...githubInstallationKey(INSTALLATION), orgId: TEST_ORG, status: "active" });
    expect(await boundInstallationOrg(deps, INSTALLATION)).toBe(TEST_ORG);
    w.db.set({ ...githubInstallationKey(INSTALLATION), orgId: TEST_ORG, status: "suspended" });
    expect(await boundInstallationOrg(deps, INSTALLATION)).toBeUndefined();
    w.db.set({ ...githubInstallationKey(INSTALLATION), orgId: "not-an-org", status: "active" });
    expect(await boundInstallationOrg(deps, INSTALLATION)).toBeUndefined();
  });
});

describe("the head index", () => {
  it("is one item per commit and one per branch, in the org's own partition, expiring with the table's mark", () => {
    const items = prHeadItems(TABLE, { orgId: TEST_ORG, repositoryFullName: "Acme/Payments", headSha: HEAD_A, taskId: TASK_ID, repositoryId: "payments", number: 7, branch: BRANCH }, NOW);
    expect(items).toHaveLength(2);
    const [commit, branch] = items.map((item) => item.Put!.Item!);
    expect(String(commit!.pk)).toContain(TEST_ORG);
    expect(commit).toMatchObject({ sk: HEAD_A, taskId: TASK_ID, orgId: TEST_ORG, repositoryId: "payments", number: 7 });
    expect(branch).toMatchObject({ sk: `branch:${BRANCH}` });
    expect(commit!.indexExpiresAt).toBe(Math.floor(NOW / 1000) + 90 * 86_400);
    expect(prHeadItems(TABLE, { orgId: TEST_ORG, repositoryFullName: "acme/payments", headSha: HEAD_A, taskId: TASK_ID, repositoryId: "payments", number: 7 }, NOW)).toHaveLength(1);
  });
});
