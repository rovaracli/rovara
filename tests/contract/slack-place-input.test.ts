// What the Slack "place" field accepts (source-row lane, task 11, B): a bare channel ID, a Slack channel link (`https://<workspace>.slack.com/archives/<ID>` or `https://app.slack.com/client/<TEAM>/<ID>`),
// or the full `slack:<team>/<channel>` place. One pure function in the contracts, used by the screen (to fill the ID) and again by the server (which never trusts the screen).
import { describe, expect, it } from "vitest";
import { SOURCE_PICKER_KINDS, SourceOptionsQuerySchema, SourceOptionsViewSchema, parseSlackPlaceInput, slackPlaceFieldText } from "@agentx/cloud-contracts";
import * as web from "@agentx/cloud-contracts/web";

const UUID = "11111111-1111-4111-8111-111111111111";
describe("parseSlackPlaceInput", () => {
  it("a bare channel, private group or direct message ID", () => {
    for (const id of ["C0123ABCD", "G0123ABCD", "D0123ABCD"]) expect(parseSlackPlaceInput(id), id).toEqual({ form: "id", channelId: id });
    expect(parseSlackPlaceInput("  C0123ABCD \n")).toEqual({ form: "id", channelId: "C0123ABCD" });
  });

  it("the full place keeps its team (only the exact form)", () => {
    expect(parseSlackPlaceInput("slack:T0AAAAAAA/C0123ABCD")).toEqual({ form: "scope", teamId: "T0AAAAAAA", channelId: "C0123ABCD" });
    for (const bad of ["slack:T0AAAAAAA", "slack:T0AAAAAAA/", "slack:T0AAAAAAA/C0123ABCD/x", "slack:t0aaaaaaa/C0123ABCD", "slack:T0AAAAAAA/c0123abcd", "github:repo/9"]) expect(parseSlackPlaceInput(bad), bad).toBeUndefined();
  });

  it("a workspace link: https://<workspace>.slack.com/archives/<ID>, with a message, a thread, a query, a fragment or a trailing slash", () => {
    for (const link of [
      "https://acme.slack.com/archives/C0123ABCD", "https://acme.slack.com/archives/C0123ABCD/", "https://acme-corp.slack.com/archives/C0123ABCD/p1700000000123456",
      "https://acme.slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=1700000000.123456&cid=C0123ABCD", "https://acme.slack.com/archives/C0123ABCD#frag", "  https://acme.slack.com/archives/C0123ABCD  ",
      "https://acme.enterprise.slack.com/archives/C0123ABCD",
    ]) expect(parseSlackPlaceInput(link), link).toEqual({ form: "archives", channelId: "C0123ABCD" });
    expect(parseSlackPlaceInput("https://acme.slack.com/archives/G0123ABCD")).toEqual({ form: "archives", channelId: "G0123ABCD" });
    expect(parseSlackPlaceInput("https://acme.slack.com/archives/D0123ABCD")).toEqual({ form: "archives", channelId: "D0123ABCD" });
  });

  it("an app link: https://app.slack.com/client/<TEAM>/<ID> keeps its team", () => {
    expect(parseSlackPlaceInput("https://app.slack.com/client/T0AAAAAAA/C0123ABCD")).toEqual({ form: "client", teamId: "T0AAAAAAA", channelId: "C0123ABCD" });
    expect(parseSlackPlaceInput("https://app.slack.com/client/T0AAAAAAA/C0123ABCD/thread/C0123ABCD-1700000000.123456")).toEqual({ form: "client", teamId: "T0AAAAAAA", channelId: "C0123ABCD" });
    expect(parseSlackPlaceInput("https://app.slack.com/client/E0ENTERPR/G0123ABCD?x=1")).toEqual({ form: "client", teamId: "E0ENTERPR", channelId: "G0123ABCD" });
  });

  it("junk is undefined: other hosts, other schemes, credentials, a user or workspace page, a lower-case ID, a channel name, empty and very long text", () => {
    for (const junk of [
      "", "   ", "general", "#general", "c0123abcd", "C0", "U0123ABCD", "T0123ABCD", "C0123ABCD extra", "C0123ABCD/x",
      "http://acme.slack.com/archives/C0123ABCD", "ftp://acme.slack.com/archives/C0123ABCD", "https://evil.com/archives/C0123ABCD", "https://slack.com.evil.com/archives/C0123ABCD",
      "https://evilslack.com/archives/C0123ABCD", "https://acme.slack.com.evil.com/archives/C0123ABCD", "https://user:pw@acme.slack.com/archives/C0123ABCD",
      "https://acme.slack.com/", "https://acme.slack.com/team/U0123ABCD", "https://acme.slack.com/archives/", "https://acme.slack.com/archives/general", "https://acme.slack.com/archives/c0123abcd",
      "https://app.slack.com/client/T0AAAAAAA", "https://app.slack.com/client/T0AAAAAAA/U0123ABCD", "https://app.slack.com/client/x/C0123ABCD", "https://app.slack.com/other/T0AAAAAAA/C0123ABCD",
      "https://acme.slack.com/archives/C0123ABCD".padEnd(400, "a"), "C0123ABCD‮",
    ]) expect(parseSlackPlaceInput(junk), JSON.stringify(junk)).toBeUndefined();
  });

  it("the web entry carries the same function (the screen uses it, and so does the server)", () => {
    expect(web.parseSlackPlaceInput).toBe(parseSlackPlaceInput);
  });
});

describe("slackPlaceFieldText: what the screen puts in the field (the server reads the same forms)", () => {
  it("an ID or workspace link becomes the bare ID; an app link of a workspace (T...) keeps its team; an Enterprise (E...) app link becomes the bare ID too, because only the server knows the install's workspace", () => {
    expect(slackPlaceFieldText(" C0123ABCD ")).toBe("C0123ABCD");
    expect(slackPlaceFieldText("https://acme.slack.com/archives/G0123ABCD/p1700000000123456")).toBe("G0123ABCD");
    expect(slackPlaceFieldText("https://app.slack.com/client/T0AAAAAAA/C0123ABCD")).toBe("slack:T0AAAAAAA/C0123ABCD");
    expect(slackPlaceFieldText("https://app.slack.com/client/E0ENTERPR/C0123ABCD")).toBe("C0123ABCD");
  });
  it("the full place and anything else stay as typed", () => {
    for (const text of ["slack:T1/C9", "slack:E0ENTERPR/C0123ABCD", " slack:T0AAAAAAA/C0123ABCD ", "general", "https://example.com/archives/C0123ABCD", ""]) expect(slackPlaceFieldText(text), text).toBe(text);
  });
  it("the web entry carries it", () => { expect(web.slackPlaceFieldText).toBeTypeOf("function");
    expect(web.slackPlaceFieldText).toBe(slackPlaceFieldText); });
});

describe("the private picker kind", () => {
  it("is one more picker kind, with its own query and an answer that can say the editor has no linked Slack account", () => {
    expect(SOURCE_PICKER_KINDS).toEqual(["slack", "linear", "jira", "slack-private"]);
    expect(SourceOptionsQuerySchema.safeParse({ kind: "slack-private" }).success).toBe(true);
    expect(SourceOptionsQuerySchema.safeParse({ kind: "slack-private", user: "U0123ABCD" }).success).toBe(false);
    expect(SourceOptionsViewSchema.safeParse({ kind: "slack-private", options: [], notLinked: true }).success).toBe(true);
    expect(SourceOptionsViewSchema.safeParse({ kind: "slack-private", options: [], notLinked: false }).success).toBe(false);
    expect(SourceOptionsQuerySchema.safeParse({ kind: "slack-private", cursor: `${UUID}.1.` }).success).toBe(true);
  });
});
