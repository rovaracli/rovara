// Enterprise foundations P6: where a code host's delivery enters the broker. An unknown host kind is refused with one fixed sentence and never read as GitHub; the host's own verification runs
// before anything is consumed; each event is reserved once (a repeat is dropped, an id reused with other content is refused); and a new event wakes the tracking row of the task it is
// about, read through the neutral link (the neutral row, then GitHub's old row).
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editionPolicy, prHeadKey, type CodeHost, type CodeHostEvent } from "../../packages/contracts/src/index.js";
import { handleCodeHostWebhook, type CodeHostEventsDependencies } from "../../packages/broker/src/aws/broker/code-host-events.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost, fakeSignedDelivery } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { EVENT_CONFLICT_MESSAGE, MAX_EVENTS_PER_DELIVERY, NO_EVENTS_MESSAGE, receiveCodeHostDelivery } from "../../packages/broker/src/plugins/events/intake.js";
import { codeHostEventHash, codeHostEventKey, dynamoEventReservations } from "../../packages/broker/src/plugins/events/reservations.js";
import { codeHostRepositoryKey } from "../../packages/broker/src/plugins/events/repository-key.js";
import { NO_HOST_MESSAGE, createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { findLinkedChangeRequest, linkedChangeRequestItem, linkedChangeRequestKey } from "../../packages/broker/src/rovara-code/linked-change-requests.js";
import { TRACKING_COALESCE_SECONDS, TRACKING_HEARTBEAT_MINUTES, TRACKING_REVIEW_COALESCE_SECONDS } from "../../packages/contracts/src/rovara-code.js";
import { trackingRecoveryItem } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { NOW, TABLE, TASK_ID, world as trackingWorld, type TrackingWorld } from "../support/rovara-code-tracking.js";
import { githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../plugins/github-deliveries.js";

/** What a promise that must be refused was refused with. */
async function refusalOf(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

const FAKE_URL = "https://git.example.test/acme/api";
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as typeof TEST_ORG;
const COALESCE = TRACKING_COALESCE_SECONDS * 1_000;
const REVIEW_COALESCE = TRACKING_REVIEW_COALESCE_SECONDS * 1_000;
const GITHUB = {} as Parameters<typeof githubCodeHost>[0];
const SCOPE = { system: "webhook" } as const;

afterEach(() => vi.restoreAllMocks());

function registry(extra: CodeHost[] = [], github = githubCodeHost(GITHUB, { credentialRef: "github", webhookSecret: webhookSecretReader() })) {
  const fake = new FakeCodeHost(new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" }));
  return { fake, github, router: createPluginRegistry({ codeHosts: [github, fake, ...extra], checkRunners: [], policy: editionPolicy("enterprise") }).codeHost };
}
const fakeDelivery = (cr = "7", delivery = "d-1", event: "cr.opened" | "cr.updated" | "cr.merged" | "cr.closed" = "cr.updated") => fakeSignedDelivery({ delivery, event, cr });

describe("P6: a host kind this install has not registered is refused, and never read as GitHub", () => {
  it.each(["examplehost", "GitHub", "git hub", "../github", "", "x".repeat(64)])("refuses kind %j with one fixed sentence, before the delivery is read, with nothing reserved", async (kind) => {
    const { github, router } = registry();
    const normalise = vi.spyOn(github.events as { normalise: NonNullable<CodeHost["events"]["normalise"]> }, "normalise");
    const db = new FakeDynamoDb();
    const consume = vi.fn(async () => undefined);
    const refused = await refusalOf(receiveCodeHostDelivery({
      router, kind, delivery: githubDelivery("pull_request", githubPayloads.pullRequest("opened")), scope: SCOPE,
      reservations: dynamoEventReservations({ documentClient: db, tableName: TABLE, now: () => NOW }), consume,
    }));
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refused.message).toContain(NO_HOST_MESSAGE);
    // The sentence never names the kind that was asked for.
    if (kind.length > 0) expect(refused.message).not.toContain(kind);
    expect(normalise).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(db.items.size).toBe(0);
  });

  it("serves a registered kind, and only through the host registered under that name", async () => {
    const { fake, github, router } = registry();
    const fakeNormalise = vi.spyOn(fake.events as { normalise: NonNullable<CodeHost["events"]["normalise"]> }, "normalise");
    const githubNormalise = vi.spyOn(github.events as { normalise: NonNullable<CodeHost["events"]["normalise"]> }, "normalise");
    const result = await receiveCodeHostDelivery({
      router, kind: "fake", delivery: fakeDelivery(), scope: SCOPE,
      reservations: dynamoEventReservations({ documentClient: new FakeDynamoDb(), tableName: TABLE, now: () => NOW }), consume: async () => undefined,
    });
    expect(result).toMatchObject({ host: "fake", duplicates: 0 });
    expect(fakeNormalise).toHaveBeenCalledTimes(1);
    expect(githubNormalise).not.toHaveBeenCalled();
  });

  it("refuses a host that does not receive webhooks, or has no normaliser (a GitHub adapter given no secret)", async () => {
    const noSecret = githubCodeHost(GITHUB, { credentialRef: "github" });
    const { router } = registry([], noSecret);
    for (const kind of ["github"]) {
      const refused = await refusalOf(receiveCodeHostDelivery({
        router, kind, delivery: githubDelivery("push", githubPayloads.push("refs/heads/x")), scope: SCOPE,
        reservations: dynamoEventReservations({ documentClient: new FakeDynamoDb(), tableName: TABLE, now: () => NOW }), consume: async () => undefined,
      }));
      expect(refused.message).toContain(NO_EVENTS_MESSAGE);
    }
    const polling = new FakeCodeHost(new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" }));
    // A host that polls is not a webhook host even if it has a normaliser to hand: the mode decides.
    const honest = polling.events.normalise!.bind(polling.events);
    (polling as { events: CodeHost["events"] }).events = { mode: "poll", normalise: honest };
    const refused = await refusalOf(receiveCodeHostDelivery({
      router: createPluginRegistry({ codeHosts: [noSecret, polling], checkRunners: [], policy: editionPolicy("enterprise") }).codeHost, kind: "fake", delivery: fakeDelivery(), scope: SCOPE,
      reservations: dynamoEventReservations({ documentClient: new FakeDynamoDb(), tableName: TABLE, now: () => NOW }), consume: async () => undefined,
    }));
    expect(refused.message).toContain(NO_EVENTS_MESSAGE);
  });
});

describe("P6: the host verifies a delivery before anything is consumed", () => {
  it("consumes and reserves nothing from a delivery that does not verify, on either host", async () => {
    const { router } = registry();
    for (const [kind, delivery] of [
      ["fake", { ...fakeDelivery(), headers: { "x-fake-signature": `sha256=${"0".repeat(64)}`, "x-fake-delivery": "d-1" } }],
      ["github", githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { signature: signGithubBody("other") })],
    ] as const) {
      const db = new FakeDynamoDb();
      const consume = vi.fn(async () => undefined);
      await expect(receiveCodeHostDelivery({ router, kind, delivery, scope: SCOPE, reservations: dynamoEventReservations({ documentClient: db, tableName: TABLE, now: () => NOW }), consume })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
      expect(consume).not.toHaveBeenCalled();
      expect(db.items.size).toBe(0);
    }
  });

  it("refuses an event that names another host than the one it came through (an adapter cannot speak for GitHub)", async () => {
    const lying = new FakeCodeHost(new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" }));
    (lying as { events: CodeHost["events"] }).events = { mode: "webhook", normalise: async () => [{ eventId: "e1", host: "github", type: "change_request.updated", ref: { repository: { url: FAKE_URL }, id: "7", url: "" } }] };
    const { router } = registry([], githubCodeHost(GITHUB, { credentialRef: "github" }));
    const routerWithLiar = createPluginRegistry({ codeHosts: [githubCodeHost(GITHUB, { credentialRef: "github" }), lying], checkRunners: [], policy: editionPolicy("enterprise") }).codeHost;
    void router;
    const consume = vi.fn(async () => undefined);
    await expect(receiveCodeHostDelivery({ router: routerWithLiar, kind: "fake", delivery: fakeDelivery(), scope: SCOPE, reservations: dynamoEventReservations({ documentClient: new FakeDynamoDb(), tableName: TABLE, now: () => NOW }), consume })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(consume).not.toHaveBeenCalled();
  });

  it("checks every event of a delivery before it consumes the first, and refuses a delivery that maps to too many", async () => {
    const make = (events: unknown[]) => {
      const host = new FakeCodeHost(new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" }));
      (host as { events: CodeHost["events"] }).events = { mode: "webhook", normalise: async () => events as CodeHostEvent[] };
      return createPluginRegistry({ codeHosts: [githubCodeHost(GITHUB, { credentialRef: "github" }), host], checkRunners: [], policy: editionPolicy("enterprise") }).codeHost;
    };
    const good = { eventId: "e1", host: "fake", type: "change_request.updated", ref: { repository: { url: FAKE_URL }, id: "7", url: "" } };
    const consume = vi.fn(async () => undefined);
    const db = new FakeDynamoDb();
    const input = { kind: "fake", delivery: fakeDelivery(), scope: SCOPE, reservations: dynamoEventReservations({ documentClient: db, tableName: TABLE, now: () => NOW }), consume };
    await expect(receiveCodeHostDelivery({ ...input, router: make([good, { ...good, eventId: "e2", type: "no.such.event" }]) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(consume).not.toHaveBeenCalled();
    expect(db.items.size).toBe(0);
    const many = Array.from({ length: MAX_EVENTS_PER_DELIVERY + 1 }, (_, index) => ({ ...good, eventId: `e${String(index)}` }));
    await expect(receiveCodeHostDelivery({ ...input, router: make(many) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("P6: each event is consumed once", () => {
  function intake() {
    const { router } = registry();
    const db = new FakeDynamoDb();
    const consume = vi.fn<(event: CodeHostEvent) => Promise<void>>(async () => undefined);
    const run = (delivery = fakeDelivery()) => receiveCodeHostDelivery({ router, kind: "fake", delivery, scope: SCOPE, reservations: dynamoEventReservations({ documentClient: db, tableName: TABLE, now: () => NOW }), consume });
    return { db, consume, run };
  }

  it("drops a redelivery of an event it has consumed", async () => {
    const { db, consume, run } = intake();
    expect(await run()).toMatchObject({ consumed: [{ eventId: "d-1" }], duplicates: 0 });
    expect(await run()).toMatchObject({ consumed: [], duplicates: 1 });
    expect(await run()).toMatchObject({ consumed: [], duplicates: 1 });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(db.get(codeHostEventKey({ host: "fake", eventId: "d-1" }))).toMatchObject({ status: "COMPLETED", hostKind: "fake" });
  });

  it("keys the event by host kind and id, so the same id from another host is another event", async () => {
    const { db, consume, run } = intake();
    await run();
    db.set({ ...codeHostEventKey({ host: "github", eventId: "d-1" }), status: "COMPLETED", eventHash: "x", hostKind: "github" });
    expect(await run(fakeDelivery("7", "d-1"))).toMatchObject({ duplicates: 1 });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("refuses an id reused with different content, and consumes nothing for it", async () => {
    const { consume, run } = intake();
    await run(fakeDelivery("7", "d-1", "cr.updated"));
    const refused = await refusalOf(run(fakeDelivery("7", "d-1", "cr.merged")));
    expect(refused.message).toContain(EVENT_CONFLICT_MESSAGE);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("offers an event again when its first attempt did not finish, and then not again", async () => {
    const { consume, run } = intake();
    consume.mockRejectedValueOnce(new Error("store down"));
    await expect(run()).rejects.toThrow("store down");
    expect(await run()).toMatchObject({ consumed: [{ eventId: "d-1" }], duplicates: 0 });
    expect(await run()).toMatchObject({ consumed: [], duplicates: 1 });
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("hashes an event the same whatever order its keys arrive in, and differently when any value differs", () => {
    const base = { eventId: "e", host: "fake", type: "change_request.updated", ref: { repository: { url: FAKE_URL }, id: "7", url: "" } } as const;
    const reordered = { ref: { url: "", id: "7", repository: { url: FAKE_URL } }, type: "change_request.updated", host: "fake", eventId: "e" } as const;
    expect(codeHostEventHash(base as CodeHostEvent)).toBe(codeHostEventHash(reordered as CodeHostEvent));
    expect(codeHostEventHash({ ...base, ref: { ...base.ref, id: "8" } })).not.toBe(codeHostEventHash(base as CodeHostEvent));
    expect(codeHostEventHash({ ...base, actor: "x" })).not.toBe(codeHostEventHash(base as CodeHostEvent));
  });
});

describe("P6: the repository key", () => {
  it("keeps GitHub's old spelling exactly: owner/name in lower case, .git and case ignored", () => {
    for (const address of ["https://github.com/Acme/Payments", "https://github.com/acme/payments.git", "https://github.com/ACME/PAYMENTS"]) expect(codeHostRepositoryKey("github", address)).toBe("acme/payments");
  });
  it("keys another kind by kind and address, keeping the path's case, and never conflates two hosts or two repositories", () => {
    expect(codeHostRepositoryKey("fake", "https://Git.Example.test/Acme/Api.git/")).toBe("fake:https://git.example.test/Acme/Api");
    expect(codeHostRepositoryKey("examplehost", "https://git.example.test/Acme/Api")).not.toBe(codeHostRepositoryKey("fake", "https://git.example.test/Acme/Api"));
    expect(codeHostRepositoryKey("fake", "https://git.example.test/Acme/Api")).not.toBe(codeHostRepositoryKey("fake", "https://git.example.test/acme/api"));
  });
  it("has no key for an address the kind cannot name", () => {
    for (const address of ["not a url", "ssh://git@host/x", "https://user:pw@host/x", "https://github.com/acme", "https://gitlab.com/acme/x"]) expect(codeHostRepositoryKey("github", address), address).toBeUndefined();
    expect(codeHostRepositoryKey("fake", "ftp://host/x")).toBeUndefined();
    expect(codeHostRepositoryKey("fake", "https://host/a%23b#frag")).toBe("fake:https://host/a%23b");
  });
});

describe("P6: the link from a change request to its task is read from the neutral row, then GitHub's old row", () => {
  function linkWorld() {
    const w = trackingWorld();
    return { w, deps: { documentClient: w.db, tableName: TABLE } };
  }
  const neutral = (overrides: Record<string, unknown> = {}) => linkedChangeRequestItem(TABLE, {
    hostKind: "fake", repositoryAddress: FAKE_URL, changeRequestId: "7", repositoryId: "api", number: 7, url: `${FAKE_URL}/pull/7`, taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: "2026-11-01T00:00:00.000Z", ...overrides,
  })!.Put.Item;

  it("finds a GitHub link written before this existed, as before", async () => {
    const { deps } = linkWorld();
    expect(await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "7" })).toMatchObject({ source: "github-legacy", taskId: TASK_ID, repositoryId: "payments", number: 7, repositoryKey: "acme/payments" });
    expect(await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: "https://github.com/Acme/Payments.git", id: "7" })).toMatchObject({ source: "github-legacy" });
    expect(await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "8" })).toBeUndefined();
  });

  it("finds a neutral link on any host, and prefers it to the old row", async () => {
    const { w, deps } = linkWorld();
    w.db.set({ ...neutral() });
    expect(await findLinkedChangeRequest(deps, { hostKind: "fake", repositoryAddress: FAKE_URL, id: "7" })).toMatchObject({ source: "neutral", taskId: TASK_ID, repositoryId: "api" });
    w.db.set({ ...neutral({ hostKind: "github", repositoryAddress: "https://github.com/acme/payments", repositoryId: "payments", taskId: "00000000-0000-4000-8000-0000000000b9" }) });
    expect(await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "7" })).toMatchObject({ source: "neutral", taskId: "00000000-0000-4000-8000-0000000000b9" });
  });

  it("never reads GitHub's old rows for another host", async () => {
    const { deps } = linkWorld();
    expect(await findLinkedChangeRequest(deps, { hostKind: "fake", repositoryAddress: "https://github.com/acme/payments", id: "7" })).toBeUndefined();
  });

  it("does not take a row that says something other than its key says, and does not fall back to the old row for it", async () => {
    const { w, deps } = linkWorld();
    const key = linkedChangeRequestKey("github", "https://github.com/acme/payments", "7")!;
    for (const change of [{ hostKind: "fake" }, { repositoryKey: "acme/other" }, { changeRequestId: "8" }, { entityType: "SOMETHING" }, { taskId: undefined }, { number: "7" }]) {
      w.db.set({ ...neutral({ hostKind: "github", repositoryAddress: "https://github.com/acme/payments" }), ...key, ...change });
      expect(await findLinkedChangeRequest(deps, { hostKind: "github", repositoryAddress: "https://github.com/acme/payments", id: "7" }), JSON.stringify(change)).toBeUndefined();
    }
  });

  it("cannot key an id or an address that is not one, so such a link is never found", async () => {
    const { deps } = linkWorld();
    for (const id of ["", "7#8", "a b", "x".repeat(201), "-1"]) expect(await findLinkedChangeRequest(deps, { hostKind: "fake", repositoryAddress: FAKE_URL, id })).toBeUndefined();
    expect(linkedChangeRequestKey("fake", "not a url", "7")).toBeUndefined();
    expect(linkedChangeRequestItem(TABLE, { hostKind: "fake", repositoryAddress: "not a url", changeRequestId: "7", repositoryId: "api", number: 7, url: "", taskId: TASK_ID, workspaceId: "w", candidateDigest: "c", createdAt: "t" })).toBeUndefined();
  });

  it("keys whole-number ids so they sort, as the old key's numbers did", () => {
    expect(linkedChangeRequestKey("fake", FAKE_URL, "7")!.sk).toBe("CR#0000000007");
    expect(linkedChangeRequestKey("fake", FAKE_URL, "abc-1")!.sk).toBe("CR#abc-1");
  });
});

describe("P6: a new event wakes the tracking row of the task it is about", () => {
  interface Setup { w: TrackingWorld; deps: CodeHostEventsDependencies; orgs: { current: typeof TEST_ORG | undefined } }
  const row = (w: TrackingWorld) => w.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${TASK_ID}`)!;

  /** A task whose one pull request is on the fake host (a neutral link) or on GitHub (the old link). */
  async function setup(on: "fake" | "github"): Promise<Setup> {
    const w = trackingWorld({ pullRequests: [{ repositoryId: on === "fake" ? "api" : "payments", number: 7 }] });
    if (on === "fake") {
      for (const key of [...w.db.items.keys()]) if (key.includes("GITHUB_PR#")) w.db.items.delete(key);
      w.db.set({ ...linkedChangeRequestItem(TABLE, { hostKind: "fake", repositoryAddress: FAKE_URL, changeRequestId: "7", repositoryId: "api", number: 7, url: `${FAKE_URL}/pull/7`, taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: "2026-11-01T00:00:00.000Z" })!.Put.Item });
      w.setWorkflow({ pullRequests: [{ repositoryId: "api", number: 7, headSha: "a".repeat(40), url: `${FAKE_URL}/pull/7`, candidateDigest: "c".repeat(64), required: true, state: "OPEN" }] });
    }
    // The row as a published task's is: a tracking row due at the heartbeat, which a wake brings forward.
    for (const key of [...w.db.items.keys()]) if (key.includes("WORKFLOW_MERGE_RECOVERY")) w.db.items.delete(key);
    await w.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem(TABLE, TASK_ID, new Date(NOW + TRACKING_HEARTBEAT_MINUTES * 60_000).toISOString())] }));
    const orgs: Setup["orgs"] = { current: TEST_ORG };
    const { router } = registry();
    const deps: CodeHostEventsDependencies = {
      router, documentClient: w.db, tableName: TABLE, now: () => w.now(), loadTask: (id) => w.deps.loadTask(id),
      repositoryUrl: async (_p, _r, repositoryId) => repositoryId === "api" ? FAKE_URL : `https://github.com/acme/${repositoryId}`,
      orgOf: async () => orgs.current,
    };
    return { w, deps, orgs };
  }

  it("a fake host's update wakes the row 30 seconds ahead; a review, 10", async () => {
    for (const [delivery, wait] of [[fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }), COALESCE], [fakeSignedDelivery({ delivery: "r1", event: "review", cr: "7", state: "APPROVED" }), REVIEW_COALESCE], [fakeSignedDelivery({ delivery: "m1", event: "cr.merged", cr: "7" }), COALESCE]] as const) {
      const s = await setup("fake");
      expect(await handleCodeHostWebhook(s.deps, "fake", delivery)).toMatchObject({ status: "ACCEPTED", events: 1, wakes: ["woken"] });
      expect(row(s.w)).toMatchObject({ wakeAt: NOW, nextAttemptAt: NOW + wait });
    }
  });

  it("a redelivery wakes nothing: the second answer is a duplicate and the row is as the first left it", async () => {
    const s = await setup("fake");
    const delivery = fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" });
    await handleCodeHostWebhook(s.deps, "fake", delivery);
    const after = structuredClone(row(s.w));
    s.w.setNow(NOW + 5_000);
    expect(await handleCodeHostWebhook(s.deps, "fake", delivery)).toMatchObject({ status: "DUPLICATE", events: 0, duplicates: 1, wakes: [] });
    expect(row(s.w)).toEqual(after);
  });

  it("an opened change request and an unrelated one leave the row alone", async () => {
    const s = await setup("fake");
    const before = structuredClone(row(s.w));
    expect(await handleCodeHostWebhook(s.deps, "fake", fakeSignedDelivery({ delivery: "o1", event: "cr.opened", cr: "7" }))).toMatchObject({ wakes: ["none"] });
    expect(await handleCodeHostWebhook(s.deps, "fake", fakeSignedDelivery({ delivery: "u9", event: "cr.updated", cr: "99" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(s.w)).toEqual(before);
  });

  it("is scoped to the host's org binding: another org, no binding, or a task of another org wake nothing", async () => {
    const other = await setup("fake");
    other.orgs.current = OTHER_ORG;
    expect(await handleCodeHostWebhook(other.deps, "fake", fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(other.w).wakeAt).toBeUndefined();
    const unbound = await setup("fake");
    unbound.orgs.current = undefined;
    expect(await handleCodeHostWebhook(unbound.deps, "fake", fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(unbound.w).wakeAt).toBeUndefined();
    const crossed = await setup("fake");
    crossed.w.setTask({ orgId: OTHER_ORG });
    expect(await handleCodeHostWebhook(crossed.deps, "fake", fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(crossed.w).wakeAt).toBeUndefined();
  });

  it("wakes nothing when the link names another task or the pinned repository is another one", async () => {
    const relinked = await setup("fake");
    relinked.w.db.set({ ...relinked.w.db.get(linkedChangeRequestKey("fake", FAKE_URL, "7")!)!, taskId: "00000000-0000-4000-8000-0000000000b2" });
    expect(await handleCodeHostWebhook(relinked.deps, "fake", fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }))).toMatchObject({ wakes: ["unfollowed"] });
    const repinned = await setup("fake");
    repinned.deps.repositoryUrl = async () => "https://git.example.test/acme/other";
    expect(await handleCodeHostWebhook(repinned.deps, "fake", fakeSignedDelivery({ delivery: "u1", event: "cr.updated", cr: "7" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(repinned.w).wakeAt).toBeUndefined();
  });

  it("wakes the task a check or a push names, through the head index", async () => {
    const s = await setup("fake");
    const repositoryKey = codeHostRepositoryKey("fake", FAKE_URL)!;
    s.w.db.set({ ...prHeadKey(TEST_ORG, repositoryKey, "a".repeat(40)), entityType: "PR_HEAD", orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "api", number: 7 });
    s.w.db.set({ ...prHeadKey(TEST_ORG, repositoryKey, "branch:rovara/x"), entityType: "PR_HEAD", orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "api", number: 7 });
    expect(await handleCodeHostWebhook(s.deps, "fake", fakeSignedDelivery({ delivery: "c1", event: "check", revision: "a".repeat(40), name: "unit", conclusion: "success" }))).toMatchObject({ wakes: ["woken"] });
    const byBranch = await setup("fake");
    byBranch.w.db.set({ ...prHeadKey(TEST_ORG, repositoryKey, "branch:rovara/x"), entityType: "PR_HEAD", orgId: TEST_ORG, taskId: TASK_ID, repositoryId: "api", number: 7 });
    expect(await handleCodeHostWebhook(byBranch.deps, "fake", fakeSignedDelivery({ delivery: "p1", event: "push", branch: "rovara/x", revision: "f".repeat(40) }))).toMatchObject({ wakes: ["woken"] });
    const unknown = await setup("fake");
    expect(await handleCodeHostWebhook(unknown.deps, "fake", fakeSignedDelivery({ delivery: "c2", event: "check", revision: "9".repeat(40), name: "unit", conclusion: "success" }))).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(unknown.w).wakeAt).toBeUndefined();
  });

  it("GitHub: a signed review delivery wakes a task linked by the OLD row, 10 seconds ahead, exactly as the old route does", async () => {
    const s = await setup("github");
    const delivery = githubDelivery("pull_request_review", { ...githubPayloads.review("submitted", "approved"), repository: { id: 1234, full_name: "acme/payments" } });
    expect(await handleCodeHostWebhook(s.deps, "github", delivery)).toMatchObject({ status: "ACCEPTED", wakes: ["woken"] });
    expect(row(s.w)).toMatchObject({ wakeAt: NOW, nextAttemptAt: NOW + REVIEW_COALESCE });
  });

  it("GitHub: a signed delivery for a repository no task follows wakes nothing", async () => {
    const s = await setup("github");
    const delivery = githubDelivery("pull_request", { ...githubPayloads.pullRequest("synchronize"), repository: { id: 5, full_name: "acme/elsewhere" } });
    expect(await handleCodeHostWebhook(s.deps, "github", delivery)).toMatchObject({ wakes: ["unfollowed"] });
    expect(row(s.w).wakeAt).toBeUndefined();
  });

  it("a verified delivery that maps to no event is ignored", async () => {
    const s = await setup("github");
    expect(await handleCodeHostWebhook(s.deps, "github", githubDelivery("fork", { repository: { full_name: "acme/payments" } }))).toMatchObject({ status: "IGNORED", events: 0 });
  });

  it("an unknown kind is refused with the fixed sentence by the broker entry too", async () => {
    const s = await setup("fake");
    await expect(handleCodeHostWebhook(s.deps, "examplehost", fakeDelivery())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(NO_HOST_MESSAGE) as unknown });
  });
});
