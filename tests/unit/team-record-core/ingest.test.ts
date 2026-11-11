import { describe, expect, it } from "vitest";
import { recordEventKey, recordSourceConfigIndexValue, recordSourceIndexValue, recordScopeIndexValue } from "@agentx/cloud-contracts";
import { teamRecordPk } from "@rovara-code/contracts";
import { createSourceConfigPort } from "../../../packages/broker/src/team-record/sink.js";
import { eventFromItem, deterministicEventId } from "../../../packages/broker/src/team-record/store.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, T0, addSource, githubDraft, rows, setLock, setMode, world } from "../../support/team-record-core.js";

const DAY = 86_400;
const seconds = T0 / 1000;
const SLACK_SCOPE = "slack:T1/C9";
const slackDraft = (extra = {}) => githubDraft({
  source: "slack", kind: "slack.message", repo: undefined, sourceRef: { system: "T1", id: "T1/C9/1.1", version: "1" }, links: ["https://acme.slack.com/archives/C9/p11"],
  audience: { kind: "restricted", acl: { source: "slack", scope: SLACK_SCOPE, groups: ["T1"], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } }, ...extra,
});

describe("ingest: the stored row", () => {
  it("stores one strict row with the keys, indexes and cleaned text", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const text = "Use it.\nmail me bob@acme.com or +1 (415) 555-0134 account 123456789012\n```ts\nconst secret = 1;\n```\nzero​width password=hunter2hunter2";
    const outcome = await w.sink.put(githubDraft({ text }));
    expect(outcome).toEqual({ status: "stored" });
    const [item] = rows(w, "TEAM_RECORD_EVENT");
    const id = deterministicEventId(ORG_A, "github", "github.com", "c-1", "1");
    expect(item).toMatchObject({ ...recordEventKey(ORG_A, "web", "2026-10-30T10:00:00.000Z", id), source: "github", trust: "member", retention: "D", scope: GITHUB_SCOPE });
    expect(item!.gsi1pk).toBe(recordSourceIndexValue(ORG_A, "github.com", "c-1"));
    expect(item!.gsi3pk).toBe(recordScopeIndexValue(ORG_A, GITHUB_SCOPE));
    expect(item!.gsi2pk).toBe(`WS#${ORG_A}#ACTOR#dev-1`);
    const stored = eventFromItem(item)!;
    expect(stored.text).toContain("Use it.");
    expect(stored.text).not.toContain("bob@acme.com");
    expect(stored.text).not.toContain("555-0134");
    expect(stored.text).not.toContain("123456789012");
    expect(stored.text).not.toContain("const secret");
    expect(stored.text).toContain("[code omitted]");
    expect(stored.text).toContain("zerowidth");
    expect(stored.text).not.toContain("hunter2hunter2");
    expect(item!.pk).toBe(teamRecordPk(ORG_A, "web"));
  });

  it("is idempotent: the same item version is one row, a new version is another", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await w.sink.put(githubDraft())).toEqual({ status: "stored" });
    expect(await w.sink.put(githubDraft())).toEqual({ status: "duplicate" });
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(1);
    expect(await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-1", version: "2" } }))).toEqual({ status: "stored" });
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(2);
  });

  it("keeps the same item of two workspaces apart", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await addSource(w, { orgId: ORG_B, source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft());
    await w.sink.put(githubDraft({ workspaceId: ORG_B }));
    const pks = rows(w, "TEAM_RECORD_EVENT").map((item) => item.pk);
    expect(new Set(pks)).toEqual(new Set([teamRecordPk(ORG_A, "web"), teamRecordPk(ORG_B, "web")]));
  });

  it("never lets a row's trust exceed its actor's, and stores no text on a rovara-trust row", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ trust: "rovara", actor: { sourceId: "9", trust: "outsider" } }));
    const [item] = rows(w, "TEAM_RECORD_EVENT");
    expect(item!.trust).toBe("outsider");
    const own = world();
    await own.sink.put({ ...githubDraft({ trust: "rovara", actor: undefined, source: "rovara", kind: "rovara.merged", sourceRef: { system: "rovara", id: "t1", version: "1" }, audience: { kind: "project" }, retention: "C" }) });
    const [ownRow] = rows(own, "TEAM_RECORD_EVENT");
    expect(ownRow!.text).toBeUndefined();
    expect(ownRow!.trust).toBe("rovara");
  });

  it("drops a link that is not a plain http(s) permalink", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft({ links: ["https://ok.example/x", "javascript:alert(1)", "https://user:pw@evil.example/", "not a url"] }));
    expect(eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!.links).toEqual(["https://ok.example/x"]);
  });
});

describe("ingest: retention routing", () => {
  it("stores no row for an outside source under A or B, and no text", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "D" });
    for (const retention of ["A", "B"] as const) expect(await w.sink.put(githubDraft({ retention, sourceRef: { system: "github.com", id: `x-${retention}`, version: "1" } }))).toEqual({ status: "refused", reason: "retention_not_stored" });
    expect(rows(w, "TEAM_RECORD_EVENT")).toHaveLength(0);
  });

  it("keeps Rovara's own structured event under A, with no text and no vector", async () => {
    const w = world();
    const draft = githubDraft({ source: "rovara", kind: "rovara.send_back", repo: undefined, sourceRef: { system: "rovara", id: "sb-1", version: "1" }, audience: { kind: "project" }, structured: { stage: "REVIEW", round: 1 }, retention: "A" });
    expect(await w.sink.put(draft)).toEqual({ status: "stored" });
    const row = eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!;
    expect(row.text).toBeUndefined();
    expect(row.structured).toEqual({ stage: "REVIEW", round: 1 });
    expect(w.embedder.calls).toHaveLength(0);
  });

  it("C drops the text at 30 days but the row stays 90 days (the archiver takes it at 90); D keeps the row 90 days with text", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "D" });
    await w.sink.put(githubDraft({ retention: "C", sourceRef: { system: "github.com", id: "c", version: "1" }, occurredAt: new Date(T0).toISOString() }));
    await w.sink.put(githubDraft({ retention: "D", sourceRef: { system: "github.com", id: "d", version: "1" }, occurredAt: new Date(T0).toISOString() }));
    const [c, d] = ["c", "d"].map((id) => eventFromItem(rows(w, "TEAM_RECORD_EVENT").find((item) => (item.sourceRef as { id: string }).id === id))!);
    expect(c!.textExpiresAt).toBe(seconds + 30 * DAY);
    expect(c!.hotExpiresAt).toBe(seconds + 90 * DAY);
    expect(c!.indexExpiresAt).toBe(seconds + 97 * DAY);
    expect(d!.textExpiresAt).toBeUndefined();
    expect(d!.hotExpiresAt).toBe(seconds + 90 * DAY);
    expect(d!.indexExpiresAt).toBe(seconds + 97 * DAY);
    expect(rows(w, "TEAM_RECORD_EVENT").every((item) => typeof item.indexExpiresAt === "number")).toBe(true);
  });

  it("a late arrival still stays at least a day", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    await w.sink.put(githubDraft({ retention: "C", occurredAt: "2025-01-01T00:00:00.000Z" }));
    expect(eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!.hotExpiresAt).toBeGreaterThanOrEqual(seconds + DAY);
  });

  it("refuses a retention above the source row's ceiling and the Public edition's Slack C and D", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, retention: "C" });
    expect(await w.sink.put(githubDraft({ retention: "D" }))).toEqual({ status: "refused", reason: "retention_exceeds_source" });
    const pub = world({ edition: "public" });
    // The setting itself is refused (I-11), so the Sources tab never shows a retention ingest would refuse.
    expect(await addSource(pub, { source: "slack", scope: SLACK_SCOPE, retention: "D" })).toEqual({ status: "refused", reason: "slack_public_fixed_a_b" });
    expect(await addSource(pub, { source: "slack", scope: SLACK_SCOPE, retention: "C" })).toEqual({ status: "refused", reason: "slack_public_fixed_a_b" });
    // B needs the workspace's explicit opt-in (Q4); without it the row is refused, with it B stores no row (the text goes to the distiller in memory).
    expect(await addSource(pub, { source: "slack", scope: SLACK_SCOPE, retention: "B" })).toEqual({ status: "refused", reason: "slack_notes_need_opt_in" });
    expect(await addSource(pub, { source: "slack", scope: SLACK_SCOPE, retention: "B", notesOptIn: true })).toEqual({ status: "saved" });
    expect(await pub.sink.put(slackDraft({ retention: "B" }))).toEqual({ status: "refused", reason: "retention_not_stored" });
    expect(await pub.sink.put(slackDraft({ retention: "D" }))).toEqual({ status: "refused", reason: "retention_exceeds_source" });
    // A stored row from before the rule (retention D, or B with no opt-in) is read as live-only by the taps' config port and refused by ingest.
    const stale = world({ edition: "public" });
    stale.db.set({ pk: `WS#${ORG_A}#P#web`, sk: "SOURCE#slack#x", entityType: "TEAM_RECORD_SOURCE", workspaceId: ORG_A, project: "web", source: "slack", scope: SLACK_SCOPE, enabled: true, retention: "D", exclude: [], audienceDefault: "maintainers", health: "unknown", addedBy: "d", updatedAt: "2026-10-30T10:00:00.000Z", gsi1pk: recordSourceConfigIndexValue(ORG_A, "slack", SLACK_SCOPE) });
    expect(await stale.sink.put(slackDraft({ retention: "D" }))).toEqual({ status: "refused", reason: "slack_public_fixed_a_b" });
    expect(await createSourceConfigPort(stale.deps).get(ORG_A, "slack", SLACK_SCOPE)).toMatchObject({ retention: "A" });
    const ent = world({ edition: "enterprise" });
    await addSource(ent, { source: "slack", scope: SLACK_SCOPE, retention: "C" });
    expect(await ent.sink.put(slackDraft({ retention: "C" }))).toEqual({ status: "stored" });
  });
});

describe("ingest: source rows, mode and exclusions", () => {
  it("refuses an outside source with no row, a disabled row, another project's scope and an excluded actor", async () => {
    const w = world();
    expect(await w.sink.put(githubDraft())).toEqual({ status: "refused", reason: "no_source_row" });
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, enabled: false });
    expect(await w.sink.put(githubDraft())).toEqual({ status: "refused", reason: "source_disabled" });
    const x = world();
    await addSource(x, { source: "github", scope: GITHUB_SCOPE, project: "other" });
    expect(await x.sink.put(githubDraft({ project: "web" }))).toEqual({ status: "refused", reason: "project_mismatch" });
    const e = world();
    await addSource(e, { source: "github", scope: GITHUB_SCOPE, exclude: ["123"] });
    expect(await e.sink.put(githubDraft())).toEqual({ status: "refused", reason: "excluded" });
    for (const world of [w, x, e]) expect(rows(world, "TEAM_RECORD_EVENT")).toHaveLength(0);
  });

  it("takes the project from the source row when the tap gave none", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE, project: "web" });
    await w.sink.put(githubDraft({ project: undefined }));
    expect(rows(w, "TEAM_RECORD_EVENT")[0]!.pk).toBe(teamRecordPk(ORG_A, "web"));
  });

  it("refuses a row with no scope unless it is Rovara's own, and a workspace id that is not an org", async () => {
    const w = world();
    expect(await w.sink.put(githubDraft({ audience: { kind: "project" } }))).toEqual({ status: "refused", reason: "no_scope" });
    expect(await w.sink.put(githubDraft({ workspaceId: "ws-1" }))).toEqual({ status: "refused", reason: "workspace" });
    expect(await w.sink.put(githubDraft({ project: "Bad Project" }))).toEqual({ status: "refused", reason: "project" });
  });

  it("captures nothing when the mode is Off, a company lock says Off, or the mode cannot be read", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    setMode(w, ORG_A, "web", "off");
    expect(await w.sink.put(githubDraft())).toEqual({ status: "refused", reason: "capture_off" });
    setMode(w, ORG_A, "web", "collect");
    expect(await w.sink.put(githubDraft())).toEqual({ status: "stored" });
    setLock(w, ORG_A, "off");
    expect(await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-2", version: "1" } }))).toEqual({ status: "refused", reason: "capture_off" });
    const broken = world();
    await addSource(broken, { source: "github", scope: GITHUB_SCOPE });
    broken.db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 5 });
    expect(await broken.sink.put(githubDraft())).toEqual({ status: "refused", reason: "capture_off" });
    expect(rows(broken, "TEAM_RECORD_EVENT")).toHaveLength(0);
  });

  it("captures by default (Suggest), and a company lock can only make the mode stricter: On over a project that says Off stays Off (M8)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    expect(await w.sink.put(githubDraft())).toEqual({ status: "stored" });
    setMode(w, ORG_A, "web", "off");
    setLock(w, ORG_A, "on");
    expect(await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-3", version: "1" } }))).toEqual({ status: "refused", reason: "capture_off" });
  });

  it("refuses a private scope with more than 500 principals (it cannot be represented)", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    const principals = Array.from({ length: 501 }, (_, i) => String(i));
    const audience = { kind: "restricted" as const, acl: { source: "github" as const, scope: GITHUB_SCOPE, principals, capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" as const } };
    expect(await w.sink.put(githubDraft({ audience }))).toEqual({ status: "refused", reason: "acl_too_large" });
  });
});

describe("ingest: the vector", () => {
  it("writes the vector and clears embedPending", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    await w.sink.put(githubDraft());
    const row = eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!;
    expect(row.embeddingRef).toBe(`event:${row.id}`);
    expect(row.embedPending).toBeUndefined();
    expect(w.vectorItems).toHaveLength(1);
    expect(w.vectorItems[0]!.metadata).toMatchObject({ audience_kind: "restricted", scope: GITHUB_SCOPE, project: "web", trust: "member", tier: "hot", kind: "event", ref: `${row.id}@${row.occurredAt}` });
  });

  it("keeps the row with embedPending when the embedding or the index fails, and logs no error text", async () => {
    const w = world();
    await addSource(w, { source: "github", scope: GITHUB_SCOPE });
    w.embedder.fail = true;
    expect(await w.sink.put(githubDraft())).toEqual({ status: "stored" });
    expect(eventFromItem(rows(w, "TEAM_RECORD_EVENT")[0])!.embedPending).toBe(true);
    w.embedder.fail = false;
    w.vectors.failPut = true;
    await w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-9", version: "1" } }));
    expect(rows(w, "TEAM_RECORD_EVENT").every((item) => item.embedPending === true)).toBe(true);
    expect(JSON.stringify(w.logs)).not.toContain("secret detail");
  });

  it("makes no vector when the retention keeps no text", async () => {
    const w = world();
    await w.sink.put(githubDraft({ source: "rovara", kind: "rovara.merged", repo: undefined, sourceRef: { system: "rovara", id: "m", version: "1" }, audience: { kind: "project" }, retention: "A" }));
    expect(w.embedder.calls).toHaveLength(0);
  });
});
