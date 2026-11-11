// Slice 5 "Outside tools": the watched Jira and Linear sources are read through the company's own connection, the tracker's own history says who put the label on, and a source that cannot be
// read fails with a fixed code the maintainer is shown (never silently, never with the tracker's words).
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { adfText, intakeSearchesOf, jiraActorConfirmer, jiraActorOf, jiraIntakeSearch, linearIntakeSearch } from "../../packages/broker/src/triggers/intake-searches.js";
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
          changelog: { histories: [{ created: "2026-11-07T09:00:00.000+0000", author: { accountId: "acct-eve", accountType: "atlassian" }, items: [{ field: "status", fromString: "a", toString: "b" }] }, { created: "2026-11-07T09:05:00.000+0000", author: { accountId: "acct-dana", accountType: "atlassian" }, items: [{ field: "labels", fromString: "bug", toString: "bug rovara" }] }] } },
        { id: "10002", key: "PAY-13", fields: { summary: "No history" }, changelog: { histories: [] } },
        { id: "10003", key: "PAY-14", fields: { summary: "By an app" }, changelog: { histories: [{ author: { accountId: "app-1", accountType: "app" }, items: [{ field: "labels", fromString: "", toString: "rovara" }] }] } },
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
          history: { nodes: [{ actor: { id: "lin-dana" }, addedLabelIds: ["lab-1"] }, { actor: { id: "lin-eve" }, addedLabelIds: ["lab-1"] }] } },
        { id: "u2", identifier: "ENG-8", title: "Own", url: "https://linear.app/acme/issue/ENG-8/own", labels: { nodes: [{ id: "lab-1", name: "rovara" }] }, history: { nodes: [{ actor: { id: "rovara-user" }, addedLabelIds: ["lab-1"] }] } },
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
        history: { nodes: [{ createdAt: "2026-11-07T09:00:00.000Z", actor: { id: "lin-a" }, addedLabelIds: ["lab-1"] }, { createdAt: "2026-11-07T09:30:00.000Z", actor: { id: "lin-b" }, addedLabelIds: ["lab-1"] }] } },
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
