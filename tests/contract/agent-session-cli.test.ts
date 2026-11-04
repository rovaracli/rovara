// Plan 5 Task 23: `agentx sessions`, `session show|follow|unfollow|comment|tell|stop|retry|take-over|share` and `agentx home` against a fake control plane:
// the route and body each command sends, the session link it prints, and the safety points. A `202 NEEDS_CONFIRMATION` answer (take-over, a company
// share) prints the confirmation link, exits 0 and never starts a sign-in; every word the server wrote is made safe before it is printed; a refusal
// (SESSION_LEVEL_REQUIRED, LOCAL_AGENT_NOT_ALLOWED) is printed as the server wrote it.
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs, CELL } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const SES = "ses_aaaaaaaaaaaaaaaaaaaa";
const SES2 = "ses_bbbbbbbbbbbbbbbbbbbb";
const DEV = "d".repeat(64);
const LINK = `${CELL}/s/${SES}`;
const CONFIRM = `${CELL}/v1/app/approve/apr_cccccccccccccccccccc?ticket=tkt_abc123`;
const members = Response.json({ members: [{ developerId: DEV, name: "Mia", email: "mia@acme.dev", role: "member", joinedAt: "2026-10-01T00:00:00.000Z", identities: ["cloud"] }] });

const view = (extra: Record<string, unknown> = {}) => ({
  session: {
    sessionId: SES, kind: "task", title: "Fix the login bug", project: "payments", owner: { developerId: DEV, name: "Priya" }, status: "running", step: "Writing the change",
    peek: "Reading auth.ts", cost: { spentUsd: 1.25, payer: { kind: "member", name: "Priya" } }, approvals: [], followers: 1, viewingNow: [],
    you: { level: "edit", owner: true, following: true, actions: ["watch", "comment", "steer", "stop"] }, link: LINK, ...extra,
  },
});
const tile = (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ({
  sessionId, kind: "task", title, project: "payments", owner: { developerId: DEV, name: "Priya" }, level: "edit", summary: { status: "running", step: "Coding", costUsd: 0.5 }, ...extra,
});
const liveTile = (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ({
  sessionId, kind: "task", title, project: "payments", owner: { developerId: DEV, name: "Priya" }, status: "needs_person", statusWords: "Needs a person", step: "Plan ready", costUsd: 2, needsYou: true, following: false, actions: ["watch"], ...extra,
});
const refusal = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });
const confirmation = (extra: Record<string, unknown> = {}) => Response.json({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: CONFIRM, changes: ["Priya becomes the owner of \"Fix the login bug\"."], ...extra }, { status: 202 });
const sent = (h: Awaited<ReturnType<typeof agentsCli>>) => h.calls.map((call) => `${call.method} ${call.path}${call.query}`);

describe("agentx sessions", () => {
  it("lists your sessions by default, and with --mine, --shared or --project the one list asked for", async () => {
    const h = await agentsCli({
      "GET /v1/app/sessions?owner=me": Response.json({ sessions: [tile(SES, "Fix the login bug"), tile(SES2, "Add a retry")] }),
      "GET /v1/app/sessions?shared=me": Response.json({ sessions: [tile(SES2, "Shared with me")] }),
      "GET /v1/app/sessions?project=payments": Response.json({ sessions: [], next: "sealed.cursor" }),
    });
    expect(await h.run(["sessions"])).toBe(0);
    expect(h.stdout()).toContain(SES);
    expect(h.stdout()).toContain("Fix the login bug");
    expect(h.stdout()).toContain(SES2);
    expect(await h.run(["sessions", "--mine"])).toBe(0);
    expect(await h.run(["sessions", "--shared"])).toBe(0);
    expect(h.stdout()).toContain("Shared with me");
    expect(await h.run(["sessions", "--project", "payments"])).toBe(0);
    expect(h.stdout()).toContain("No sessions");
    expect(sent(h)).toEqual(["GET /v1/app/sessions?owner=me", "GET /v1/app/sessions?owner=me", "GET /v1/app/sessions?shared=me", "GET /v1/app/sessions?project=payments"]);
  });

  it("continues a long list with --cursor, and says when there is more", async () => {
    const h = await agentsCli({ "GET /v1/app/sessions?owner=me&cursor=abc.def": Response.json({ sessions: [tile(SES, "One")], next: "ghi.jkl" }) });
    expect(await h.run(["sessions", "--cursor", "abc.def"])).toBe(0);
    expect(h.stdout()).toContain("--cursor ghi.jkl");
  });

  it("shows the Live wall for a filter, with the project when one is given", async () => {
    const h = await agentsCli({
      "GET /v1/app/live?filter=needs_me": Response.json({ tiles: [liveTile(SES, "Fix the login bug")] }),
      "GET /v1/app/live?filter=all&project=payments": Response.json({ tiles: [] }),
    });
    expect(await h.run(["sessions", "--live", "needs_me"])).toBe(0);
    expect(h.stdout()).toContain("Needs a person");
    expect(h.stdout()).toContain(SES);
    expect(await h.run(["sessions", "--live", "all", "--project", "payments"])).toBe(0);
    expect(sent(h)).toEqual(["GET /v1/app/live?filter=needs_me", "GET /v1/app/live?filter=all&project=payments"]);
  });

  it("refuses an unknown live filter and two lists at once without asking anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["sessions", "--live", "everything"])).toBe(2);
    expect(h.stderr()).toContain("--live takes one of");
    for (const argv of [["--mine", "--shared"], ["--live", "all", "--mine"], ["--shared", "--project", "payments"]]) expect(await h.run(["sessions", ...argv]), argv.join(" ")).toBe(2);
    expect(h.stderr()).toContain("give one of --live, --mine, --shared and --project");
    expect(h.calls).toEqual([]);
  });

  it("prints JSON with --json", async () => {
    const h = await agentsCli({ "GET /v1/app/sessions?owner=me": Response.json({ sessions: [tile(SES, "Fix the login bug")] }) });
    expect(await h.run(["--json", "sessions"])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { sessions: [{ sessionId: SES }] } });
  });
});

describe("agentx session show, follow and unfollow", () => {
  it("shows a session with its link, status, owner and what waits for you", async () => {
    const approval = { approvalId: "apr_cccccccccccccccccccc", title: "Approve the plan", confirmUrl: `${CELL}/v1/app/approve/apr_cccccccccccccccccccc` };
    const h = await agentsCli({ [`GET /v1/app/sessions/${SES}`]: Response.json(view({ approvals: [approval] })) });
    expect(await h.run(["session", "show", SES])).toBe(0);
    for (const part of [LINK, "Fix the login bug", "payments", "Priya", "Running", "Writing the change", "Approve the plan", approval.confirmUrl, "can edit"]) expect(h.stdout()).toContain(part);
    expect(sent(h)).toEqual([`GET /v1/app/sessions/${SES}`]);
  });

  it("refuses something that is not a session ID without asking anything", async () => {
    const h = await agentsCli({});
    for (const id of ["nope", "..", "ses_short", `${SES}/shares`]) expect(await h.run(["session", "show", id]), id).toBe(2);
    expect(h.stderr()).toContain("that is not a session ID");
    expect(h.calls).toEqual([]);
  });

  it("follows and unfollows", async () => {
    const h = await agentsCli({
      [`POST /v1/app/sessions/${SES}/follow`]: Response.json({ following: true }),
      [`DELETE /v1/app/sessions/${SES}/follow`]: Response.json({ following: false }),
    });
    expect(await h.run(["session", "follow", SES])).toBe(0);
    expect(h.stdout()).toContain("following");
    expect(await h.run(["session", "unfollow", SES])).toBe(0);
    expect(h.stdout()).toContain("no longer");
    expect(sent(h)).toEqual([`POST /v1/app/sessions/${SES}/follow`, `DELETE /v1/app/sessions/${SES}/follow`]);
  });
});

describe("agentx session comment and tell", () => {
  const message = (kind: string, delivery?: Record<string, unknown>) => ({ messageId: "msg_aaaaaaaaaaaaaaaaaaaa", sessionId: SES, kind, source: "app", author: { developerId: DEV, name: "Priya" }, text: "x", createdAt: "2026-10-24T09:00:00.000Z", rev: 1, ...(delivery === undefined ? {} : { delivery }) });

  it("comments, with a request id, and prints the session link", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/messages`]: Response.json(message("comment"), { status: 201 }) });
    expect(await h.run(["session", "comment", SES, "Looks good to me"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/messages`, query: "", body: { requestId: expect.stringMatching(UUID) as string, kind: "comment", text: "Looks good to me" } }]);
    expect(h.stdout()).toContain(LINK);
  });

  it("tells the agent, and says whether the message was delivered or queued", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/messages`]: Response.json(message("steer", { state: "queued", at: "2026-10-24T09:00:00.000Z" }), { status: 201 }) });
    expect(await h.run(["session", "tell", SES, "Keep the change under 50 lines"])).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({ kind: "steer", text: "Keep the change under 50 lines" });
    expect(h.stdout()).toMatch(/queued/i);
    expect(h.stdout()).toContain(LINK);
  });

  it("refuses empty text without asking anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["session", "comment", SES, "   "])).toBe(2);
    expect(await h.run(["session", "tell", SES, ""])).toBe(2);
    expect(await h.run(["session", "tell", SES, "x".repeat(10_001)])).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("prints the server's words when a viewer tries to tell the agent (SESSION_LEVEL_REQUIRED)", async () => {
    const words = "You need \"can use\" on this session to send messages to the agent. Ask Priya to share it with you.";
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/messages`]: refusal("SESSION_LEVEL_REQUIRED", words, 403) });
    expect(await h.run(["session", "tell", SES, "Go faster"])).not.toBe(0);
    expect(h.stderr()).toContain(words);
  });

  it("prints the server's words when the session is on a Mac the company has not allowed (LOCAL_AGENT_NOT_ALLOWED, stubbed)", async () => {
    const words = "claude-code isn't allowed in your company. Ask an admin to allow it.";
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/messages`]: refusal("LOCAL_AGENT_NOT_ALLOWED", words, 403) });
    expect(await h.run(["session", "tell", SES, "Go faster"])).not.toBe(0);
    expect(h.stderr()).toContain(words);
    expect(h.opened).toEqual([]);
  });
});

describe("agentx session stop and retry", () => {
  it("stops a session with a request id and prints the session that carries on", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/stop`]: Response.json(view({ status: "stopped" })) });
    expect(await h.run(["session", "stop", SES])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/stop`, query: "", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.stdout()).toMatch(/stopped/i);
    expect(h.stdout()).toContain(LINK);
  });

  it("says nothing was running, with the server's words, and never Stop requested, when the stop found nothing to stop", async () => {
    const plain = await agentsCli({ [`POST /v1/app/sessions/${SES}/stop`]: Response.json({ ...view(), stop: "NOTHING_RUNNING" }) });
    expect(await plain.run(["session", "stop", SES])).toBe(0);
    expect(plain.stdout()).toContain("Nothing was running to stop.");expect(plain.stdout()).not.toContain("Stop requested");
    const words = "This task is blocked, not running. To end it, use Close task (it checks for unpublished work first).";
    const blocked = await agentsCli({ [`POST /v1/app/sessions/${SES}/stop`]: Response.json({ ...view(), stop: "NOTHING_RUNNING", message: words }) });
    expect(await blocked.run(["session", "stop", SES])).toBe(0);
    expect(blocked.stdout()).toContain(words);expect(blocked.stdout()).not.toContain("Stop requested");
  });

  it("retries a session and prints the link of the new one when a new run started", async () => {
    const fresh = `${CELL}/s/${SES2}`;
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/retry`]: Response.json(view({ sessionId: SES2, link: fresh, retryOf: SES })) });
    expect(await h.run(["session", "retry", SES])).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: `/v1/app/sessions/${SES}/retry`, body: { requestId: expect.stringMatching(UUID) as string } });
    expect(h.stdout()).toContain(fresh);
  });
});

describe("agentx session take-over (202 NEEDS_CONFIRMATION)", () => {
  it("prints the confirm link, exits 0 and never starts a sign-in", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: confirmation() });
    expect(await h.run(["session", "take-over", SES])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/take-over`, query: "", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.stdout()).toContain(`Confirm this in your browser: ${CONFIRM}`);
    expect(h.stdout()).toContain("becomes the owner");
    expect(h.stderr()).toBe("");
    expect(`${h.stdout()}${h.stderr()}`).not.toMatch(/sign-in|signed in|has ended/i);
    expect(h.opened).toEqual([]);
  });

  it("prints the link under --json too", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: confirmation() });
    expect(await h.run(["--json", "session", "take-over", SES])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM } });
  });

  it("does not print a link that is not a plain https address, and says what happened", async () => {
    for (const confirmUrl of [`https://evil.example/v1/app/approve/apr_cccccccccccccccccccc`, "https://x@evil.example/", `${CELL.replace("https://", "https://:pw@")}/x`, `${CELL.replace("https://", "https://user:pw@")}/v1/app/approve/x`, `${CELL.replace("https://", "https://user@")}/x`,
      `${CELL}@evil.example/x`, `${CELL}.evil.example/x`, `${CELL.replace(":443", "")}:8443/x`, "http://evil.example/approve", "https://evil.example/\u202eapprove", "https://evil.example/a b", `https://evil.example/${"a".repeat(2100)}`, "javascript:alert(1)"]) {
      const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: confirmation({ confirmUrl }) });
      expect(await h.run(["session", "take-over", SES]), confirmUrl.slice(0, 30)).not.toBe(0);
      expect(h.stdout(), confirmUrl.slice(0, 30)).not.toContain("Confirm this in your browser");
      expect(`${h.stdout()}${h.stderr()}`, confirmUrl.slice(0, 30)).not.toContain("evil.example");
    }
  });

  it("makes the changes the server lists safe to print", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: confirmation({ changes: ["Mia\u001b[2J\u202e becomes the owner", `leaked agxr_${"a".repeat(43)}`] }) });
    expect(await h.run(["session", "take-over", SES])).toBe(0);
    expect(h.stdout()).not.toContain("\u001b");
    expect(h.stdout()).not.toContain("\u202e");
    expect(h.stdout()).not.toContain("agxr_");
  });

  it("prints the server's refusal and starts no sign-in even when the answer asks for a fresh one (403 REAUTH_REQUIRED)", async () => {
    const words = "Confirming this needs a sign-in from the last ten minutes.";
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: refusal("REAUTH_REQUIRED", words, 403) });
    expect(await h.run(["session", "take-over", SES])).not.toBe(0);
    expect(h.stderr()).toContain(words);
    expect(h.opened).toEqual([]);
    expect(sent(h)).toEqual([`POST /v1/app/sessions/${SES}/take-over`]);
  });

  it("treats a 202 that is not a confirmation as an unexpected answer", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/take-over`]: Response.json({ ok: true }, { status: 202 }) });
    expect(await h.run(["session", "take-over", SES])).not.toBe(0);
    expect(h.stdout()).not.toContain("Confirm this");
  });
});

describe("links on another host, or with userinfo, are never printed", () => {
  const OTHER = "https://evil.example/s/ses_aaaaaaaaaaaaaaaaaaaa";
  const WITH_USER = `${CELL.replace("https://", "https://x@")}/v1/app/approve/apr_cccccccccccccccccccc`;

  it("session show builds the link from the ID and leaves a foreign decision link out", async () => {
    const approval = { approvalId: "apr_cccccccccccccccccccc", title: "Approve the plan", confirmUrl: WITH_USER };
    const h = await agentsCli({ [`GET /v1/app/sessions/${SES}`]: Response.json(view({ link: OTHER, approvals: [approval, { ...approval, confirmUrl: "https://evil.example/approve" }] })) });
    expect(await h.run(["session", "show", SES])).toBe(0);
    expect(h.stdout()).toContain(LINK);
    expect(h.stdout()).not.toContain("evil.example");
    expect(h.stdout()).not.toContain("x@");
  });

  it("the Live wall and Home leave foreign decision and button links out", async () => {
    const h = await agentsCli({
      "GET /v1/app/live?filter=all": Response.json({ tiles: [liveTile(SES, "Fix", { approvalUrl: "https://evil.example/approve" }), liveTile(SES2, "Other", { approvalUrl: WITH_USER })] }),
      "GET /v1/app/home": Response.json({ cards: [{ cardId: `failure:${SES}`, kind: "failure", title: "T", reason: "R", at: "2026-10-24T09:00:00.000Z", buttons: [{ label: "Open", action: "open", href: "https://evil.example/x", method: "GET" }, { label: "Review", action: "confirm", href: WITH_USER, method: "GET" }] }], total: 1 }),
    });
    expect(await h.run(["sessions", "--live", "all"])).toBe(0);
    expect(await h.run(["home"])).toBe(0);
    expect(h.stdout()).not.toContain("evil.example");
    expect(h.stdout()).not.toContain("x@");
  });
});

describe("agentx session share", () => {
  const share = (principal: Record<string, unknown>, level: string) => ({ share: { principal, level, sharedBy: { developerId: DEV, name: "Priya" }, sharedAt: "2026-10-24T09:00:00.000Z" } });

  it("shares with a person by email", async () => {
    const h = await agentsCli({ "GET /v1/app/org/members": members, [`PUT /v1/app/sessions/${SES}/shares`]: Response.json(share({ kind: "member", developerId: DEV }, "use")) });
    expect(await h.run(["session", "share", SES, "--with", "mia@acme.dev", "--level", "use"])).toBe(0);
    expect(h.calls.at(-1)).toEqual({ method: "PUT", path: `/v1/app/sessions/${SES}/shares`, query: "", body: { requestId: expect.stringMatching(UUID) as string, principal: { kind: "member", developerId: DEV }, level: "use" } });
    expect(h.stdout()).toContain("Mia");
    expect(h.stdout()).toContain(LINK);
  });

  it("shares with a project", async () => {
    const h = await agentsCli({ [`PUT /v1/app/sessions/${SES}/shares`]: Response.json(share({ kind: "project", project: "payments" }, "view")) });
    expect(await h.run(["session", "share", SES, "--with", "project:payments", "--level", "view"])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: `/v1/app/sessions/${SES}/shares`, query: "", body: { requestId: expect.stringMatching(UUID) as string, principal: { kind: "project", project: "payments" }, level: "view" } }]);
    expect(h.stdout()).toContain("payments");
  });

  it("sharing with the company prints the confirm link, exits 0 and never starts a sign-in (202)", async () => {
    const h = await agentsCli({ [`PUT /v1/app/sessions/${SES}/shares`]: confirmation({ changes: ["Share \"Fix the login bug\" with everyone in your company (can view)"] }) });
    expect(await h.run(["session", "share", SES, "--with", "company", "--level", "view"])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: `/v1/app/sessions/${SES}/shares`, query: "", body: { requestId: expect.stringMatching(UUID) as string, principal: { kind: "org" }, level: "view" } }]);
    expect(h.stdout()).toContain(`Confirm this in your browser: ${CONFIRM}`);
    expect(`${h.stdout()}${h.stderr()}`).not.toMatch(/sign-in|signed in|has ended/i);
    expect(h.opened).toEqual([]);
  });

  it("says a company share that already stands needs nothing", async () => {
    const h = await agentsCli({ [`PUT /v1/app/sessions/${SES}/shares`]: Response.json(share({ kind: "org" }, "view")) });
    expect(await h.run(["session", "share", SES, "--with", "company", "--level", "view"])).toBe(0);
    expect(h.stdout()).toContain("everyone in your company");
    expect(h.stdout()).not.toContain("Confirm this");
  });

  it("refuses a missing or unknown --with or --level without sharing anything", async () => {
    const h = await agentsCli({});
    for (const argv of [["--level", "view"], ["--with", "company"], ["--with", "company", "--level", "manage"], ["--with", "project:", "--level", "view"]]) {
      expect(await h.run(["session", "share", SES, ...argv]), argv.join(" ")).toBe(2);
    }
    expect(h.calls).toEqual([]);
  });

  it("asks nobody when the email names nobody in the company", async () => {
    const h = await agentsCli({ "GET /v1/app/org/members": members });
    expect(await h.run(["session", "share", SES, "--with", "nobody@acme.dev", "--level", "view"])).not.toBe(0);
    expect(sent(h)).toEqual(["GET /v1/app/org/members"]);
  });
});

describe("agentx home", () => {
  it("lists the cards with the session link and the pages their buttons open", async () => {
    const h = await agentsCli({
      "GET /v1/app/home": Response.json({
        cards: [
          { cardId: `approval:apr_cccccccccccccccccccc`, kind: "approval", title: "Approve the plan", reason: "You decide plans for payments", sessionId: SES, at: "2026-10-24T09:00:00.000Z",
            buttons: [{ label: "Review", action: "confirm", href: `${CELL}/v1/app/approve/apr_cccccccccccccccccccc`, method: "GET" }, { label: "Dismiss", action: "dismiss", href: `${CELL}/v1/app/home/cards/x/dismiss`, method: "POST" }] },
        ],
        total: 3,
      }),
    });
    expect(await h.run(["home"])).toBe(0);
    for (const part of ["Approve the plan", "You decide plans for payments", LINK, `${CELL}/v1/app/approve/apr_cccccccccccccccccccc`, "2 more"]) expect(h.stdout()).toContain(part);
    expect(h.stdout()).not.toContain("/dismiss");
    expect(sent(h)).toEqual(["GET /v1/app/home"]);
  });

  it("says when nothing needs you", async () => {
    const h = await agentsCli({ "GET /v1/app/home": Response.json({ cards: [], total: 0 }) });
    expect(await h.run(["home"])).toBe(0);
    expect(h.stdout()).toMatch(/nothing/i);
  });
});

describe("what the server wrote is made safe before it is printed", () => {
  it("neutralises control, bidi and token-shaped text in a session's title, step, peek and owner", async () => {
    const evil = `\u001b[31mred\u202e\u200b agxr_${"b".repeat(43)}`;
    const h = await agentsCli({ [`GET /v1/app/sessions/${SES}`]: Response.json(view({ title: evil, step: evil, peek: evil, owner: { developerId: DEV, name: evil }, link: `${CELL}/s/${SES}\u001b[2J` })) });
    expect(await h.run(["session", "show", SES])).toBe(0);
    for (const bad of ["\u001b", "\u202e", "\u200b", "agxr_"]) expect(h.stdout(), JSON.stringify(bad)).not.toContain(bad);
    expect(h.stdout()).toContain("[U+202E]");
  });

  it("neutralises the same in the lists and in Home", async () => {
    const evil = "bad\u001b[2J\u202etitle";
    const h = await agentsCli({
      "GET /v1/app/sessions?owner=me": Response.json({ sessions: [tile(SES, evil)] }),
      "GET /v1/app/live?filter=all": Response.json({ tiles: [liveTile(SES, evil, { statusWords: evil })] }),
      "GET /v1/app/home": Response.json({ cards: [{ cardId: `failure:${SES}`, kind: "failure", title: evil, reason: evil, at: "2026-10-24T09:00:00.000Z", buttons: [] }], total: 1 }),
    });
    for (const argv of [["sessions"], ["sessions", "--live", "all"], ["home"]]) expect(await h.run(argv)).toBe(0);
    expect(h.stdout()).not.toContain("\u001b");
    expect(h.stdout()).not.toContain("\u202e");
  });

  it("neutralises the words of a refusal", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/stop`]: refusal("SESSION_LEVEL_REQUIRED", `You need edit\u001b[2J\u202e agxr_${"c".repeat(43)}`, 403) });
    expect(await h.run(["session", "stop", SES])).not.toBe(0);
    expect(h.stderr()).not.toContain("\u001b");
    expect(h.stderr()).not.toContain("\u202e");
    expect(h.stderr()).not.toContain("agxr_");
  });
});
