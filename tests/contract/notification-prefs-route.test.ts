// UX2 slice 2 item 5 (review: missing tests): `GET`/`PUT /v1/app/me/notifications` read and write only the caller's own row in their own org (nothing in the path or body can name anyone
// else), refuse a bad body, and say email is unavailable where the install has no sender.
import { describe, expect, it } from "vitest";
import { routeNotificationPrefs } from "../../packages/broker/src/notifications/prefs-routes.js";
import { prefsKey } from "../../packages/broker/src/notifications/attention.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ORG_A, ORG_B, PRIYA, ARJUN } from "../support/agent-session-world.js";

const URL_OF = new URL("https://cell.example.com/v1/app/me/notifications");
function setup(sender = true) {
  const db = new FakeDynamoDb();
  const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-11-07T12:00:00.000Z"), ...(sender ? { ownerNotice: { ses: { send: async () => ({}) }, from: "Rovara <n@example.com>", log: () => undefined } } : {}) } as never;
  const caller = (developerId: string, orgId = ORG_A, extra: Record<string, unknown> = {}) => ({ developerId, orgId, orgRole: "member", sessionId: "s", amr: "oidc", name: "P", email: "p@example.com", ...extra }) as never;
  const call = (who: unknown, method: string, body?: unknown) => routeNotificationPrefs(deps, who as never, { method, path: URL_OF.pathname, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, URL_OF);
  return { db, caller, call };
}

describe("the notification setting route", () => {
  it("writes only the caller's own row, in their own org, whatever the body says", async () => {
    const t = setup();
    const answer = await t.call(t.caller(PRIYA), "PUT", { channel: "both" });
    expect((answer as { body: unknown }).body).toMatchObject({ channel: "both", chosen: true });
    const rows = t.db.find((item) => item["entityType"] === "NOTIFY_PREFS");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...prefsKey(ORG_A, PRIYA), developerId: PRIYA, orgId: ORG_A, channel: "both" });
    // A body that names someone else is refused (strict), and writes nothing.
    await expect(t.call(t.caller(PRIYA), "PUT", { channel: "email", developerId: ARJUN })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.call(t.caller(PRIYA), "PUT", { channel: "fax" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.db.find((item) => item["entityType"] === "NOTIFY_PREFS")).toHaveLength(1);
    // Another person, and the same person in another org, read their own defaults.
    expect(((await t.call(t.caller(ARJUN), "GET")) as { body: unknown }).body).toMatchObject({ chosen: false });
    expect(((await t.call(t.caller(PRIYA, ORG_B), "GET")) as { body: unknown }).body).toMatchObject({ chosen: false });
  });

  it("says email is unavailable where the install has no sender, and uses Slack when it is linked", async () => {
    const t = setup(false);
    const view = ((await t.call(t.caller(PRIYA, ORG_A, { slackUserId: "U0PRIYA01" }), "GET")) as { body: unknown }).body;
    expect(view).toEqual({ channel: "slack", chosen: false, slackLinked: true, emailAvailable: false, emailUnsubscribed: false, effective: { slack: true, email: false } });
    // Without Slack and without a sender, nothing can reach them (Home still lists what needs them).
    expect(((await t.call(t.caller(PRIYA), "GET")) as { body: unknown }).body).toMatchObject({ channel: "email", effective: { slack: false, email: false } });
  });

  it("the unsubscribe stops email only and keeps the channel", async () => {
    const t = setup();
    await t.call(t.caller(PRIYA), "PUT", { channel: "both" });
    const answer = ((await t.call(t.caller(PRIYA, ORG_A, { slackUserId: "U0PRIYA01" }), "PUT", { emailUnsubscribed: true })) as { body: unknown }).body;
    expect(answer).toMatchObject({ channel: "both", emailUnsubscribed: true, effective: { slack: true, email: false } });
    expect(await t.call(t.caller(PRIYA), "POST", {}).catch((error: { code?: string }) => error.code)).toBe("NOT_FOUND");
  });
});
