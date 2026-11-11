// Slice 5 "Outside tools": the watched Jira and Linear sources are read through the company's own connection, the tracker's own history says who put the label on, and a source that cannot be
// read fails with a fixed code the maintainer is shown (never silently, never with the tracker's words).
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { JIRA_CHANGELOG_PAGES_MAX, LINEAR_HISTORY_PAGES_MAX, adfText, intakeSearchesOf, jiraActOf, jiraActorConfirmer, jiraActorOf, jiraIntakeSearch, linearActOf, linearIntakeSearch } from "../../packages/broker/src/triggers/intake-searches.js";
import { pollIntakeSource } from "../../packages/broker/src/triggers/poll-intake.js";
import { listIntakeSources, replaceIntakeSources } from "../../packages/broker/src/intake/sources.js";
import type { IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const NOW = Date.parse("2026-11-07T10:00:00.000Z");
const TOKEN = ["tok", "en", "y"].join("-");

async function connections(list: Array<{ id: string; type: "jira" | "linear"; label?: string }>) {
  const fake = new FakeOrgSecrets({ env: "staging", now: () => NOW });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => NOW });
  const deps = { documentClient: db, tableName: "state", env: "staging", secrets, now: () => NOW };
  for (const entry of list) {
    await new OrgConnectionStore(deps).put({
      orgId: ORG, by: "dev-admin",
      connection: entry.type === "jira" ? { connectionId: entry.id, type: "jira", label: entry.label ?? "Jira", access: "read", siteUrl: "https://acme.atlassian.net" } : { connectionId: entry.id, type: "linear", label: entry.label ?? "Linear", access: "read" },
      secret: entry.type === "jira" ? { email: "rovara@acme.test", apiToken: TOKEN } : { apiKey: TOKEN },
    });
  }
  return { db, deps };
}
const source = (ref: Record<string, unknown>) => ({ orgId: ORG, project: "web", sourceId: "a".repeat(24), ref, setBy: "x", createdAt: "", updatedAt: "", nextPollAt: 0, failures: 0 }) as never;
const signal = new AbortController().signal;

describe("the Jira search", () => {
  it("reads open issues with the label through the site's connection, and the change log names who added it", async () => {
    const { deps } = await connections([{ id: "con_jira0000000000000001", type: "jira" }]);
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ issues: [
        { id: "10001", key: "PAY-12", fields: { summary: "Refunds fail", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Steps" }] }] }, reporter: { displayName: "Dana" } },
          changelog: { total: 2, startAt: 0, histories: [{ created: "2026-11-07T09:00:00.000+0000", author: { accountId: "acct-eve", accountType: "atlassian" }, items: [{ field: "status", fromString: "a", toString: "b" }] }, { created: "2026-11-07T09:05:00.000+0000", author: { accountId: "acct-dana", accountType: "atlassian" }, items: [{ field: "labels", fromString: "bug", toString: "bug rovara" }] }] } },
        { id: "10002", key: "PAY-13", fields: { summary: "No history" }, changelog: { total: 0, startAt: 0, histories: [] } },
        { id: "10003", key: "PAY-14", fields: { summary: "By an app" }, changelog: { total: 1, startAt: 0, histories: [{ created: "2026-11-07T09:01:00.000+0000", author: { accountId: "app-1", accountType: "app" }, items: [{ field: "labels", fromString: "", toString: "rovara" }] }] } },
        { id: "x", key: "not a key", fields: {} },
      ] }), { status: 200 });
    });
    const items = await jiraIntakeSearch({ deps, fetch: fetch as never })({ orgId: ORG, project: "web", source: source({ channel: "jira", when: { label: "rovara" }, poll: {} }), signal, limit: 50 });
    expect(urls[0]!.startsWith("https://acme.atlassian.net/rest/api/3/search/jql?")).toBe(true);
    expect(new URL(urls[0]!).searchParams.get("jql")).toBe('(labels = "rovara") AND statusCategory != Done ORDER BY updated DESC');
    expect(items).toEqual([
      { externalRef: { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" }, title: "Refunds fail", body: "Steps\n", reporter: { display: "Dana" }, actor: { kind: "person", accountId: "acct-dana" }, alternateIds: ["10001"] },
      { externalRef: { system: "jira", id: "PAY-13", url: "https://acme.atlassian.net/browse/PAY-13" }, title: "No history", body: "", reporter: { display: undefined }, alternateIds: ["10002"] },
      { externalRef: { system: "jira", id: "PAY-14", url: "https://acme.atlassian.net/browse/PAY-14" }, title: "By an app", body: "", reporter: { display: undefined }, actor: { kind: "bot" }, alternateIds: ["10003"] },
    ]);
    expect(adfText({ type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "H" }] }] })).toBe("H\n");
  });

  it("refuses a label that would change the query, and fails with fixed codes for no connection, two unnamed connections and a refused key", async () => {
    const none = await connections([]);
    const search = (deps: typeof none.deps, fetch: unknown, ref: Record<string, unknown>) => jiraIntakeSearch({ deps, fetch: fetch as never })({ orgId: ORG, project: "web", source: source(ref), signal, limit: 50 });
    await expect(search(none.deps, vi.fn(), { channel: "jira", when: { label: "x" }, poll: {} })).rejects.toMatchObject({ code: "CONNECTION_MISSING" });
    const two = await connections([{ id: "con_jira0000000000000001", type: "jira", label: "One" }, { id: "con_jira0000000000000002", type: "jira", label: "Two" }]);
    await expect(search(two.deps, vi.fn(), { channel: "jira", when: { label: "x" }, poll: {} })).rejects.toMatchObject({ code: "CONNECTION_AMBIGUOUS" });
    const refused = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(search(two.deps, refused, { channel: "jira", connection: "Two", when: { label: "x" }, poll: {} })).rejects.toMatchObject({ code: "CONNECTION_REFUSED" });
    const never = vi.fn();
    await expect(search(two.deps, never, { channel: "jira", connection: "One", when: { label: 'x" OR project = SECRET' }, poll: {} })).rejects.toMatchObject({ code: "SEARCH_FAILED" });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("the Linear search", () => {
  it("reads open issues with the label, and the newest history entry that added it names the actor", async () => {
    const { deps } = await connections([{ id: "con_lin00000000000000001", type: "linear" }]);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["authorization"]).toBe(TOKEN);
      return new Response(JSON.stringify({ data: { viewer: { id: "rovara-user" }, issues: { nodes: [
        { id: "u1", identifier: "ENG-7", title: "Crash", description: "boom", url: "https://linear.app/acme/issue/ENG-7/crash", creator: { displayName: "Lee" }, labels: { nodes: [{ id: "lab-1", name: "Rovara" }] },
          history: { pageInfo: { hasNextPage: false }, nodes: [{ createdAt: "2026-11-07T09:10:00.000Z", actor: { id: "lin-dana" }, addedLabelIds: ["lab-1"] }, { createdAt: "2026-11-07T09:00:00.000Z", actor: { id: "lin-eve" }, addedLabelIds: ["lab-1"] }] } },
        { id: "u2", identifier: "ENG-8", title: "Own", url: "https://linear.app/acme/issue/ENG-8/own", labels: { nodes: [{ id: "lab-1", name: "rovara" }] }, history: { pageInfo: { hasNextPage: false }, nodes: [{ createdAt: "2026-11-07T09:00:00.000Z", actor: { id: "rovara-user" }, addedLabelIds: ["lab-1"] }] } },
      ] } } }), { status: 200 });
    });
    const items = await linearIntakeSearch({ deps, fetch: fetch as never })({ orgId: ORG, project: "web", source: source({ channel: "tracker", system: "linear", when: { label: "rovara" } }), signal, limit: 50 });
    expect(items.map((item) => [item.externalRef.id, item.actor])).toEqual([["ENG-7", { kind: "person", accountId: "lin-dana" }], ["ENG-8", { kind: "rovara", accountId: "rovara-user" }]]);
  });
});

describe("a watched source that cannot be read", () => {
  it("is recorded as failing with its code, so the source and Home can say why", async () => {
    const { db, deps } = await connections([]);
    const table = { documentClient: db, tableName: "state", now: () => NOW };
    await replaceIntakeSources(table, { orgId: ORG, project: "web", refs: [{ channel: "tracker", system: "linear", when: { label: "rovara" } }], setBy: "x" });
    const [record] = await listIntakeSources(table, ORG, "web");
    const ports = { table, log: () => undefined } as unknown as IntakePorts;
    const outcome = await pollIntakeSource({ ports, searchFor: intakeSearchesOf({ deps }), notify: async () => undefined }, record!);
    expect(outcome).toEqual({ outcome: "failed", code: "CONNECTION_MISSING", noticed: false });
    expect((await listIntakeSources(table, ORG, "web"))[0]).toMatchObject({ failures: 1, lastError: "CONNECTION_MISSING", failingSince: NOW });
  });
});

describe("who made the act, from the tracker's own history", () => {
  const added = (at: string, accountId: string, accountType = "atlassian") => ({ created: at, author: { accountId, accountType }, items: [{ field: "labels", fromString: "", toString: "rovara" }] });
  const removed = (at: string, accountId: string) => ({ created: at, author: { accountId, accountType: "atlassian" }, items: [{ field: "labels", fromString: "rovara", toString: "" }] });

  it("is the NEWEST adder by the change's own time, whatever order the answer lists them in (review M2)", () => {
    const histories = [added("2026-11-07T09:00:00.000+0000", "acct-a"), removed("2026-11-07T09:10:00.000+0000", "acct-a"), added("2026-11-07T09:20:00.000+0000", "acct-b")];
    for (const order of [histories, [...histories].reverse(), [histories[2], histories[0], histories[1]]]) expect(jiraActorOf(order, { kind: "label", value: "rovara" })).toEqual({ kind: "person", accountId: "acct-b" });
  });

  it("is a person only for an atlassian account, as the webhook; a service-desk customer or an unknown type is nobody, an app is a bot (review M1)", () => {
    expect(jiraActorOf([added("2026-11-07T09:00:00.000+0000", "c-1", "customer")], { kind: "label", value: "rovara" })).toBeUndefined();
    expect(jiraActorOf([added("2026-11-07T09:00:00.000+0000", "c-2", "")], { kind: "label", value: "rovara" })).toBeUndefined();
    expect(jiraActorOf([added("2026-11-07T09:00:00.000+0000", "app-1", "app")], { kind: "label", value: "rovara" })).toEqual({ kind: "bot" });
  });

  it("Linear: the newest adder by createdAt, whatever the answer's order (review M2)", async () => {
    const { deps } = await connections([{ id: "con_lin00000000000000001", type: "linear" }]);
    const fetch = vi.fn(async () => Response.json({ data: { viewer: { id: "rovara-user" }, issues: { nodes: [
      { id: "u1", identifier: "ENG-9", title: "T", url: "https://linear.app/acme/issue/ENG-9/t", labels: { nodes: [{ id: "lab-1", name: "rovara" }] },
        history: { pageInfo: { hasNextPage: false }, nodes: [{ createdAt: "2026-11-07T09:00:00.000Z", actor: { id: "lin-a" }, addedLabelIds: ["lab-1"] }, { createdAt: "2026-11-07T09:30:00.000Z", actor: { id: "lin-b" }, addedLabelIds: ["lab-1"] }] } },
    ] } } }));
    const items = await linearIntakeSearch({ deps, fetch: fetch })({ orgId: ORG, project: "web", source: source({ channel: "tracker", system: "linear", when: { label: "rovara" } }), signal, limit: 50 });
    expect(items[0]!.actor).toEqual({ kind: "person", accountId: "lin-b" });
  });
});

describe("Jira's word on a webhook's actor (review I1, I1-R)", () => {
  const NOW_MS = Date.parse("2026-11-07T10:00:00.000Z");
  const eventAt = "2026-11-07T09:59:00.000Z";
  const candidate = (accountId: string, over: Record<string, unknown> = {}) => ({
    orgId: ORG, externalRef: { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" }, actor: { kind: "person" as const, accountId },
    act: { kind: "label" as const, value: "rovara" }, eventId: "jira:issue:10042:labeled:rovara:7001", occurredAt: eventAt, ...over,
  });
  const change = (id: string, created: string, accountId: string, items = [{ field: "labels", fromString: "", toString: "rovara" }]) => ({ id, created, author: { accountId, accountType: "atlassian" }, items });
  /** A Jira site: the change log in pages of `pageSize`, and the issue's labels now. */
  function jira(changes: unknown[], labels: string[] = ["rovara"], pageSize = 100) {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/changelog")) {
        const start = Number(parsed.searchParams.get("startAt") ?? "0");
        const values = changes.slice(start, start + pageSize);
        return Response.json({ values, startAt: start, isLast: start + pageSize >= changes.length });
      }
      return Response.json({ fields: { labels } });
    });
    return { fetch, urls };
  }
  const confirmerFor = async (site: ReturnType<typeof jira>) => jiraActorConfirmer({ deps: (await connections([{ id: "con_jira0000000000000001", type: "jira" }])).deps, fetch: site.fetch as never, now: () => NOW_MS });

  it("confirms the person when the event's own change (by id, near the event's time) was theirs and the label is on the issue now, reading every page", async () => {
    const changes = [...Array.from({ length: 150 }, (_, n) => change(String(6000 + n), "2026-11-01T09:00:00.000+0000", "acct-eve", [{ field: "status", fromString: "a", toString: "b" }])), change("7001", "2026-11-07T09:59:02.000+0000", "acct-dana")];
    const site = jira(changes, ["rovara"], 100);
    expect(await (await confirmerFor(site))(candidate("acct-dana"))).toBe("person");
    expect(site.urls.filter((url) => url.includes("/changelog"))).toEqual([
      "https://acme.atlassian.net/rest/api/3/issue/PAY-12/changelog?startAt=0&maxResults=100", "https://acme.atlassian.net/rest/api/3/issue/PAY-12/changelog?startAt=100&maxResults=100",
    ]);
  });

  it("is unverified for a replay of a past admin label-add with a fresh time, and the start never happens", async () => {
    // The admin really added the label, a week ago, as change 7001. The replayed body carries that change's key with today's time.
    const site = jira([change("7001", "2026-10-31T08:00:00.000+0000", "acct-admin")]);
    expect(await (await confirmerFor(site))(candidate("acct-admin"))).toBe("unverified");
  });

  it("is unverified for a forged body naming someone else, an event outside the age window, a change id Jira does not have, or a label taken off since", async () => {
    const real = [change("7001", "2026-11-07T09:59:02.000+0000", "acct-dana")];
    expect(await (await confirmerFor(jira(real)))(candidate("acct-admin"))).toBe("unverified");
    expect(await (await confirmerFor(jira(real)))(candidate("acct-dana", { occurredAt: "2026-11-01T09:59:00.000Z" }))).toBe("unverified");
    expect(await (await confirmerFor(jira(real)))(candidate("acct-dana", { eventId: "jira:issue:10042:labeled:rovara:9999" }))).toBe("unverified");
    expect(await (await confirmerFor(jira(real)))(candidate("acct-dana", { eventId: "jira:issue:10042:labeled:rovara:not-a-change" }))).toBe("unverified");
    expect(await (await confirmerFor(jira(real, [])))(candidate("acct-dana"))).toBe("unverified");
  });

  it("is unverified with no connection for the ticket's site, a link outside Atlassian, a failed read, or no act", async () => {
    const none = await connections([]);
    expect(await jiraActorConfirmer({ deps: none.deps, fetch: vi.fn() as never, now: () => NOW_MS })(candidate("acct-dana"))).toBe("unverified");
    const { deps } = await connections([{ id: "con_jira0000000000000001", type: "jira" }]);
    const never = vi.fn();
    const confirm = jiraActorConfirmer({ deps, fetch: never as never, now: () => NOW_MS });
    expect(await confirm(candidate("acct-dana", { externalRef: { system: "jira", id: "PAY-12", url: "https://other.atlassian.net/browse/PAY-12" } }))).toBe("unverified");
    expect(await confirm(candidate("acct-dana", { externalRef: { system: "jira", id: "PAY-12", url: "https://evil.example/browse/PAY-12" } }))).toBe("unverified");
    expect(never).not.toHaveBeenCalled();
    expect(await jiraActorConfirmer({ deps, fetch: vi.fn(async () => new Response("{}", { status: 500 })), now: () => NOW_MS })(candidate("acct-dana"))).toBe("unverified");
    expect(await jiraActorConfirmer({ deps: undefined })(candidate("acct-dana"))).toBe("unverified");
    expect(await confirm({ ...candidate("acct-dana"), act: undefined })).toBe("unverified");
  });
});

describe("who made the act fails closed when the history is not the whole story (the label history window)", () => {
  const LABEL = { kind: "label" as const, value: "rovara" };
  const entry = (at: string | undefined, accountId: string, items: Array<{ from: string; to: string }>, accountType = "atlassian") => ({ id: accountId, ...(at === undefined ? {} : { created: at }), author: { accountId, accountType }, items: items.map((item) => ({ field: "labels", fromString: item.from, toString: item.to })) });
  const add = (at: string | undefined, accountId: string) => entry(at, accountId, [{ from: "", to: "rovara" }]);
  const remove = (at: string | undefined, accountId: string) => entry(at, accountId, [{ from: "rovara", to: "" }]);

  describe("Jira, from a change log", () => {
    it("credits nobody when the last change to the label is a removal, in whatever order the answer lists the changes", () => {
      const log = [add("2026-11-07T09:00:00.000+0000", "acct-a"), remove("2026-11-07T09:10:00.000+0000", "acct-b")];
      for (const order of [log, [...log].reverse()]) expect(jiraActOf(order, LABEL)).toEqual({});
    });

    it("credits nobody for a tie between an add and a removal, or when any touching change has a time that cannot be read", () => {
      expect(jiraActOf([add("2026-11-07T09:00:00.000+0000", "acct-a"), remove("2026-11-07T09:00:00.000+0000", "acct-b")], LABEL)).toEqual({});
      expect(jiraActOf([add("2026-11-07T09:00:00.000+0000", "acct-a"), add(undefined, "acct-b")], LABEL)).toEqual({});
      expect(jiraActOf([add("2026-11-07T09:00:00.000+0000", "acct-a"), add("not a time", "acct-b")], LABEL)).toEqual({});
    });

    it("credits the last add when an earlier removal and add came before it, and names the change id; a change that does not touch the label is ignored", () => {
      const log = [remove("2026-11-07T09:10:00.000+0000", "acct-a"), add("2026-11-07T09:20:00.000+0000", "acct-c"), add("2026-11-07T09:00:00.000+0000", "acct-a"), { created: "bad", author: { accountId: "x", accountType: "atlassian" }, items: [{ field: "status", fromString: "a", toString: "b" }] }];
      expect(jiraActOf(log, LABEL)).toEqual({ actor: { kind: "person", accountId: "acct-c" }, changeId: "acct-c" });
    });

    it("a change that adds one label and takes another is read for the label asked, and an assignment away from Rovara after the add credits nobody for an assignment source", () => {
      expect(jiraActOf([entry("2026-11-07T09:00:00.000+0000", "acct-a", [{ from: "rovara-old", to: "rovara" }])], LABEL)).toMatchObject({ actor: { accountId: "acct-a" } });
      const assigned = (at: string, from: string, to: string) => ({ created: at, author: { accountId: "acct-a", accountType: "atlassian" }, items: [{ field: "assignee", from, to }] });
      const assignment = { kind: "assignee" as const, value: "rovara-id" };
      expect(jiraActOf([assigned("2026-11-07T09:00:00.000+0000", "", "rovara-id")], assignment).actor).toEqual({ kind: "person", accountId: "acct-a" });
      expect(jiraActOf([assigned("2026-11-07T09:00:00.000+0000", "", "rovara-id"), assigned("2026-11-07T09:05:00.000+0000", "rovara-id", "someone")], assignment)).toEqual({});
    });
  });

  describe("the Jira search, paging the change log", () => {
    const issueOf = (changelog: Record<string, unknown>) => ({ id: "10001", key: "PAY-12", fields: { summary: "S" }, changelog });
    async function run(embedded: Record<string, unknown>, pages: Array<Record<string, unknown> | number>) {
      const { deps } = await connections([{ id: "con_jira0000000000000001", type: "jira" }]);
      const urls: string[] = [];
      let next = 0;
      const fetch = vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("/search/jql")) return Response.json({ issues: [issueOf(embedded)] });
        const page = pages[next++];
        return typeof page === "number" ? new Response("{}", { status: page }) : Response.json(page ?? { values: [], isLast: true });
      });
      const items = await jiraIntakeSearch({ deps, fetch: fetch as never })({ orgId: ORG, project: "web", source: source({ channel: "jira", when: { label: "rovara" }, poll: {} }), signal, limit: 50 });
      return { actor: items[0]!.actor, urls: urls.filter((url) => url.includes("/changelog")) };
    }
    const old = add("2026-11-01T09:00:00.000+0000", "acct-old");

    it("reads the later pages when the embedded log is only the first of many, and credits the real last add", async () => {
      const result = await run({ total: 150, startAt: 0, histories: [old] }, [
        { values: [old, remove("2026-11-02T09:00:00.000+0000", "acct-x")], isLast: false }, { values: [add("2026-11-07T09:00:00.000+0000", "acct-new")], isLast: true },
      ]);
      expect(result.actor).toEqual({ kind: "person", accountId: "acct-new" });
      expect(result.urls).toEqual([
        "https://acme.atlassian.net/rest/api/3/issue/PAY-12/changelog?startAt=0&maxResults=100", "https://acme.atlassian.net/rest/api/3/issue/PAY-12/changelog?startAt=2&maxResults=100",
      ]);
    });

    it("credits nobody for an old add when a later page holds the removal (the window cut it short)", async () => {
      const result = await run({ total: 150, startAt: 0, histories: [old] }, [{ values: [old, remove("2026-11-05T09:00:00.000+0000", "acct-x")], isLast: true }]);
      expect(result.actor).toBeUndefined();
    });

    it("credits nobody when the embedded log has no total or says more than it holds, and the change log's own read then fails or comes back short", async () => {
      expect((await run({ histories: [old] }, [500])).actor).toBeUndefined();
      expect((await run({ total: 5, startAt: 0, histories: [old] }, [{ values: [] }])).actor).toBeUndefined();
    });

    it("credits nobody when the log is longer than the page cap, and reads at most that many pages", async () => {
      const pages = Array.from({ length: 12 }, (_, n) => ({ values: [add(`2026-11-0${String((n % 9) + 1)}T09:00:00.000+0000`, `acct-${String(n)}`)], isLast: false }));
      const result = await run({ total: 5000, startAt: 0, histories: [old] }, pages);
      expect(result.actor).toBeUndefined();
      expect(result.urls).toHaveLength(JIRA_CHANGELOG_PAGES_MAX);
    });

    it("uses the embedded log without another read when it says it is whole", async () => {
      const result = await run({ total: 1, startAt: 0, histories: [old] }, []);
      expect(result.actor).toEqual({ kind: "person", accountId: "acct-old" });
      expect(result.urls).toEqual([]);
    });

    it("a refused key or a rate limit while paging is the search's own failure, not an uncredited ticket", async () => {
      await expect(run({ total: 5, startAt: 0, histories: [old] }, [429])).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await expect(run({ total: 5, startAt: 0, histories: [old] }, [403])).rejects.toMatchObject({ code: "CONNECTION_REFUSED" });
    });
  });

  describe("Linear, from an issue's history", () => {
    const labelIds = new Set(["lab-1"]);
    const added = (at: string | undefined, id: string, extra: Record<string, unknown> = {}) => ({ ...(at === undefined ? {} : { createdAt: at }), actor: { id }, addedLabelIds: ["lab-1"], ...extra });
    const removed = (at: string | undefined, id: string) => ({ ...(at === undefined ? {} : { createdAt: at }), actor: { id }, removedLabelIds: ["lab-1"] });

    it("credits the last add by its own time, in whatever order the entries come", () => {
      const entries = [added("2026-11-07T09:30:00.000Z", "lin-b"), removed("2026-11-07T09:10:00.000Z", "lin-a"), added("2026-11-07T09:00:00.000Z", "lin-a")];
      for (const order of [entries, [...entries].reverse()]) expect(linearActOf(order, false, { labelIds })).toEqual({ kind: "account", accountId: "lin-b" });
    });

    it("credits nobody for a later removal, a tie, an unreadable time, or a history not read to the end", () => {
      expect(linearActOf([added("2026-11-07T09:00:00.000Z", "lin-a"), removed("2026-11-07T09:10:00.000Z", "lin-b")], false, { labelIds })).toBeUndefined();
      expect(linearActOf([added("2026-11-07T09:00:00.000Z", "lin-a"), removed("2026-11-07T09:00:00.000Z", "lin-b")], false, { labelIds })).toBeUndefined();
      expect(linearActOf([added("2026-11-07T09:00:00.000Z", "lin-a"), added("2026-11-07T09:00:00.000Z", "lin-b")], false, { labelIds })).toBeUndefined();
      expect(linearActOf([added("2026-11-07T09:00:00.000Z", "lin-a"), added(undefined, "lin-b")], false, { labelIds })).toBeUndefined();
      expect(linearActOf([added("2026-11-07T09:00:00.000Z", "lin-a")], true, { labelIds })).toBeUndefined();
      expect(linearActOf([{ createdAt: "2026-11-07T09:00:00.000Z", actor: { id: "lin-a" }, addedLabelIds: ["other"] }], false, { labelIds })).toBeUndefined();
    });

    it("an assignment to Rovara's account counts as an add and an unassignment as a removal", () => {
      const assigned = (at: string, id: string, to: string, from?: string) => ({ createdAt: at, actor: { id }, toAssigneeId: to, ...(from === undefined ? {} : { fromAssigneeId: from }) });
      expect(linearActOf([assigned("2026-11-07T09:00:00.000Z", "lin-a", "rovara-user")], false, { labelIds: new Set(), assignedTo: "rovara-user" })).toEqual({ kind: "account", accountId: "lin-a" });
      expect(linearActOf([assigned("2026-11-07T09:00:00.000Z", "lin-a", "rovara-user"), assigned("2026-11-07T09:05:00.000Z", "lin-b", "someone", "rovara-user")], false, { labelIds: new Set(), assignedTo: "rovara-user" })).toBeUndefined();
    });

    it("a bot entry is a bot", () => {
      expect(linearActOf([{ createdAt: "2026-11-07T09:00:00.000Z", botActor: { id: "bot" }, addedLabelIds: ["lab-1"] }], false, { labelIds })).toEqual({ kind: "bot" });
    });

    async function run(first: Record<string, unknown>, pages: Array<Record<string, unknown> | number>) {
      const { deps } = await connections([{ id: "con_lin00000000000000001", type: "linear" }]);
      const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
      let next = 0;
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
        bodies.push(body);
        if (body.query.includes("viewer")) return Response.json({ data: { viewer: { id: "rovara-user" }, issues: { nodes: [{ id: "u1", identifier: "ENG-9", title: "T", url: "https://linear.app/acme/issue/ENG-9/t", labels: { nodes: [{ id: "lab-1", name: "rovara" }] }, history: first }] } } });
        const page = pages[next++];
        return typeof page === "number" ? new Response("{}", { status: page }) : Response.json(page === undefined ? { errors: [{ message: "x" }] } : { data: { issue: { history: page } } });
      });
      const items = await linearIntakeSearch({ deps, fetch: fetch as never })({ orgId: ORG, project: "web", source: source({ channel: "tracker", system: "linear", when: { label: "rovara" } }), signal, limit: 50 });
      return { actor: items[0]!.actor, pageCalls: bodies.filter((body) => !body.query.includes("viewer")) };
    }

    it("pages the history with its cursor when the first 25 are not all of it, so an old add behind a newer removal credits nobody", async () => {
      const result = await run(
        { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [added("2026-11-01T09:00:00.000Z", "lin-old")] },
        [{ pageInfo: { hasNextPage: false, endCursor: null }, nodes: [removed("2026-11-05T09:00:00.000Z", "lin-x")] }],
      );
      expect(result.actor).toBeUndefined();
      expect(result.pageCalls.map((call) => call.variables)).toEqual([{ id: "u1", after: "c1" }]);
    });

    it("credits the last add found on a later page", async () => {
      const result = await run(
        { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [added("2026-11-01T09:00:00.000Z", "lin-old")] },
        [{ pageInfo: { hasNextPage: true, endCursor: "c2" }, nodes: [removed("2026-11-02T09:00:00.000Z", "lin-x")] }, { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [added("2026-11-07T09:00:00.000Z", "lin-new")] }],
      );
      expect(result.actor).toEqual({ kind: "person", accountId: "lin-new" });
      expect(result.pageCalls.map((call) => call.variables["after"])).toEqual(["c1", "c2"]);
    });

    it("credits nobody for a history without page info, a page read that fails, or more pages than the cap allows", async () => {
      expect((await run({ nodes: [added("2026-11-01T09:00:00.000Z", "lin-old")] }, [])).actor).toBeUndefined();
      expect((await run({ pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [added("2026-11-01T09:00:00.000Z", "lin-old")] }, [])).actor).toBeUndefined();
      const endless = Array.from({ length: 9 }, (_, n) => ({ pageInfo: { hasNextPage: true, endCursor: `c${String(n + 2)}` }, nodes: [] }));
      const result = await run({ pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [added("2026-11-01T09:00:00.000Z", "lin-old")] }, endless);
      expect(result.actor).toBeUndefined();
      expect(result.pageCalls).toHaveLength(LINEAR_HISTORY_PAGES_MAX);
    });

    it("a rate limit while paging is the search's own failure", async () => {
      await expect(run({ pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] }, [429])).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });
  });
});
