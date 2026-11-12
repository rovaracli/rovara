// Plan 4 Task 4: `agentx chains …` against a fake control plane: the requests each command sends, what it prints, that a broker's refusal is printed as the
// broker wrote it, and that nothing here decides an approval (R66): a change that needs a person prints the confirmation page's link.
import "../support/automations-on.js";
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";

afterEach(cleanHarnessDirs);

const CHN = "chn_aaaaaaaaaaaaaaaaaaaa";
const DEV = "d".repeat(64);
const CELL_URL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const CONFIRM = `${CELL_URL}/v1/app/approve/apr_bbbbbbbbbbbbbbbbbbbb`;
const chain = (extra: Record<string, unknown> = {}) => ({
  chainId: CHN, name: "Investigate then fix", description: "", owner: { kind: "member", developerId: DEV }, latestVersion: 2, currentVersion: 2, draftRevision: 4,
  status: "active", access: "manage", createdBy: DEV, createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z", ...extra,
});
const draft = (revision = 4, problems: unknown[] = []) => ({ draft: { revision, definition: INVESTIGATE_THEN_FIX, updatedBy: DEV, updatedAt: "2026-10-22T09:00:00.000Z" }, problems });
const members = Response.json({ members: [{ developerId: DEV, name: "Maya", email: "maya@acme.dev", role: "admin", joinedAt: "2026-10-01T00:00:00.000Z", identities: ["cloud"] }] });
const CONFLICT = "CHAIN_REVISION_CONFLICT: Someone else changed this chain's draft. Reload it and make your change again.";

describe("agentx chains list and show", () => {
  it("lists the chains of a scope or a project, and prints JSON with --json", async () => {
    const h = await agentsCli({
      "GET /v1/app/chains?scope=shared": Response.json({ chains: [chain()] }),
      "GET /v1/app/chains?project=payments": Response.json({ chains: [chain({ name: "Payments chain", currentVersion: undefined })] }),
      "GET /v1/app/chains?scope=all": Response.json({ chains: [] }),
    });
    expect(await h.run(["chains", "list", "--shared"])).toBe(0);
    expect(h.stdout()).toContain(CHN);
    expect(h.stdout()).toContain("Investigate then fix");
    expect(h.stdout()).toContain("v2");
    expect(await h.run(["--json", "chains", "list", "--project", "payments"])).toBe(0);
    expect(await h.run(["chains", "list"])).toBe(0);
    expect(h.stdout()).toContain("No chains");
    expect(h.calls.map((call) => `${call.method} ${call.path}${call.query}`)).toEqual(["GET /v1/app/chains?scope=shared", "GET /v1/app/chains?project=payments", "GET /v1/app/chains?scope=all"]);
    expect(JSON.parse(h.out.at(-2)!)).toMatchObject({ ok: true, data: { chains: [{ name: "Payments chain" }] } });
  });

  it("refuses two scopes at once without asking anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["chains", "list", "--mine", "--shared"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("shows a chain, what runs now, and the steps of the published design", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}`]: Response.json({ chain: chain(), current: { version: 2, definition: { start: "investigate", steps: INVESTIGATE_THEN_FIX.steps } } }),
    });
    expect(await h.run(["chains", "show", CHN])).toBe(0);
    expect(h.stdout()).toContain("Investigate then fix");
    expect(h.stdout()).toContain("your access: manage");
    expect(h.stdout()).toContain("runs version 2");
    for (const step of ["investigate", "approve_fix", "fix", "review"]) expect(h.stdout()).toContain(step);
  });

  it("says a chain with no published version is not published", async () => {
    const h = await agentsCli({ [`GET /v1/app/chains/${CHN}`]: Response.json({ chain: chain({ currentVersion: undefined, latestVersion: 0 }) }) });
    expect(await h.run(["chains", "show", CHN])).toBe(0);
    expect(h.stdout()).toContain("not published yet");
  });

  it("prints a refusal as the broker wrote it", async () => {
    const h = await agentsCli({ [`GET /v1/app/chains/${CHN}`]: Response.json({ error: { code: "NOT_FOUND", message: "NOT_FOUND: no chain has that ID" } }, { status: 404 }) });
    expect(await h.run(["chains", "show", CHN])).not.toBe(0);
    expect(h.stderr()).toContain("no chain has that ID");
  });
});

describe("agentx chains create", () => {
  it("creates a member's chain with a design from a file", async () => {
    const h = await agentsCli({ "POST /v1/app/chains": Response.json({ chain: chain() }, { status: 201 }) });
    const file = await h.file("chain.json", INVESTIGATE_THEN_FIX);
    expect(await h.run(["chains", "create", "--name", "Investigate then fix", "--file", file])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/chains", query: "", body: { requestId: expect.stringMatching(UUID) as string, name: "Investigate then fix", definition: INVESTIGATE_THEN_FIX } }]);
    expect(h.stdout()).toContain(CHN);
  });

  it("creates a chain with the starter design when there is no file", async () => {
    const h = await agentsCli({ "POST /v1/app/chains": Response.json({ chain: chain() }, { status: 201 }) });
    expect(await h.run(["chains", "create", "--name", "Plain", "--description", "A plain one"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, name: "Plain", description: "A plain one" });
  });

  it("creates a project's chain with its accountable maintainer, named by email", async () => {
    const h = await agentsCli({ "GET /v1/app/org/members": members, "POST /v1/app/chains": Response.json({ chain: chain({ owner: { kind: "project", project: "payments" } }) }, { status: 201 }) });
    expect(await h.run(["chains", "create", "--name", "Payments chain", "--project-owner", "payments", "--accountable", "MAYA@acme.dev"])).toBe(0);
    expect(h.calls.at(-1)!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, name: "Payments chain", owner: { kind: "project", project: "payments" }, accountable: { developerId: DEV } });
  });

  it("refuses a missing name and --accountable without --project-owner before sending anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["chains", "create"])).not.toBe(0);
    expect(await h.run(["chains", "create", "--name", "X", "--accountable", "maya@acme.dev"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx chains draft", () => {
  it("draft get prints the design, its revision and the problems found", async () => {
    const h = await agentsCli({ [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(4, [{ path: "steps.2", message: "review can never run" }])) });
    expect(await h.run(["chains", "draft", "get", CHN])).toBe(0);
    expect(h.stdout()).toContain("revision 4");
    expect(h.stdout()).toContain("\"start\": \"investigate\"");
    expect(h.stdout()).toContain("steps.2: review can never run");
  });

  it("draft set reads the revision first and sends it as expectedRevision with the design from the file", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(4)),
      [`PUT /v1/app/chains/${CHN}/draft`]: Response.json({ draft: { ...draft(5).draft } }),
    });
    const file = await h.file("definition.json", INVESTIGATE_THEN_FIX);
    expect(await h.run(["chains", "draft", "set", CHN, "--file", file])).toBe(0);
    expect(h.calls).toEqual([
      { method: "GET", path: `/v1/app/chains/${CHN}/draft`, query: "", body: undefined },
      { method: "PUT", path: `/v1/app/chains/${CHN}/draft`, query: "", body: { requestId: expect.stringMatching(UUID) as string, expectedRevision: 4, definition: INVESTIGATE_THEN_FIX } },
    ]);
    expect(h.stdout()).toContain("revision 5");
  });

  it("a 409 exits 1 and prints the broker's message exactly", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(4)),
      [`PUT /v1/app/chains/${CHN}/draft`]: Response.json({ error: { code: "CHAIN_REVISION_CONFLICT", message: CONFLICT } }, { status: 409 }),
    });
    const file = await h.file("definition.json", INVESTIGATE_THEN_FIX);
    expect(await h.run(["chains", "draft", "set", CHN, "--file", file])).toBe(1);
    expect(h.stderr()).toBe(`${CONFLICT}\n`);
    expect(h.stdout()).toBe("");
  });

  it("refuses a missing, unreadable or non-object file before asking anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["chains", "draft", "set", CHN])).not.toBe(0);
    expect(await h.run(["chains", "draft", "set", CHN, "--file", `${h.home}/missing.json`])).not.toBe(0);
    const list = await h.file("list.json", []);
    expect(await h.run(["chains", "draft", "set", CHN, "--file", list])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx chains publish, versions and rollback", () => {
  it("publish sends the revision it just read and says which version runs", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(6)),
      [`POST /v1/app/chains/${CHN}/publish`]: Response.json({ version: { version: 3, digest: "a".repeat(64) }, chain: chain({ currentVersion: 3 }), disabledTriggers: [] }),
    });
    expect(await h.run(["chains", "publish", CHN, "--note", "tighter"])).toBe(0);
    expect(h.calls[1]).toEqual({ method: "POST", path: `/v1/app/chains/${CHN}/publish`, query: "", body: { requestId: expect.stringMatching(UUID) as string, expectedDraftRevision: 6, note: "tighter" } });
    expect(h.stdout()).toContain("version 3");
  });

  it("publish names the triggers that were turned off", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(6)),
      [`POST /v1/app/chains/${CHN}/publish`]: Response.json({
        version: { version: 3 }, disabledTriggers: [{ triggerId: "ctr_cccccccccccccccccccc", problems: [{ path: "limits.maxRunUsd", message: "set a run limit and a monthly budget before adding an event or schedule trigger" }] }],
      }),
    });
    expect(await h.run(["chains", "publish", CHN])).toBe(0);
    expect(h.stdout()).toContain("ctr_cccccccccccccccccccc");
    expect(h.stdout()).toContain("limits.maxRunUsd: set a run limit");
  });

  it("a less safe publish prints the confirmation link and what it changes, and does not claim a version", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(6)),
      [`POST /v1/app/chains/${CHN}/publish`]: Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ['fix can now be reached without passing "approve_fix"'] }, { status: 202 }),
    });
    expect(await h.run(["chains", "publish", CHN])).toBe(0);
    expect(h.stdout()).toContain(CONFIRM);
    expect(h.stdout()).toContain('fix can now be reached without passing "approve_fix"');
    expect(h.stdout()).not.toContain("Published");
    expect(h.calls.map((call) => call.path)).toEqual([`/v1/app/chains/${CHN}/draft`, `/v1/app/chains/${CHN}/publish`]);
  });

  it("publish prints a refusal about the design as the broker wrote it", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/draft`]: Response.json(draft(6)),
      [`POST /v1/app/chains/${CHN}/publish`]: Response.json({ error: { code: "CONFIG_INVALID", message: "CONFIG_INVALID: steps.0: a is in a loop with no limit; set maxTraversals on the edge that goes back" } }, { status: 400 }),
    });
    expect(await h.run(["chains", "publish", CHN])).not.toBe(0);
    expect(h.stderr()).toContain("a is in a loop with no limit");
  });

  it("lists versions and marks the one that runs", async () => {
    const h = await agentsCli({
      [`GET /v1/app/chains/${CHN}/versions`]: Response.json({ versions: [
        { version: 1, digest: "a".repeat(64), publishedBy: DEV, publishedAt: "2026-10-20T00:00:00.000Z", current: false },
        { version: 2, digest: "b".repeat(64), publishedBy: DEV, publishedAt: "2026-10-21T00:00:00.000Z", current: true, note: "tighter" },
      ] }),
    });
    expect(await h.run(["chains", "versions", CHN])).toBe(0);
    expect(h.stdout()).toContain("v2 (runs now)");
    expect(h.stdout()).toContain("tighter");
  });

  it("rollback sends the version, and prints the link when the change needs a person", async () => {
    const h = await agentsCli({ [`POST /v1/app/chains/${CHN}/rollback`]: (body) => ((body as { version: number }).version === 1
      ? Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ['removes the gate "approve_fix"'] }, { status: 202 })
      : Response.json({ chain: chain({ currentVersion: 2 }), disabledTriggers: [] })) });
    expect(await h.run(["chains", "rollback", CHN, "1"])).toBe(0);
    expect(h.stdout()).toContain(CONFIRM);
    expect(await h.run(["chains", "rollback", CHN, "2"])).toBe(0);
    expect(h.stdout()).toContain(`${CHN} runs version 2 again`);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, version: 1 });
    expect(await h.run(["chains", "rollback", CHN, "0"])).not.toBe(0);
    expect(await h.run(["chains", "rollback", CHN, "two"])).not.toBe(0);
    expect(h.calls).toHaveLength(2);
  });
});

describe("agentx chains archive and share", () => {
  it("archives and unarchives", async () => {
    const h = await agentsCli({
      [`POST /v1/app/chains/${CHN}/archive`]: Response.json({ chain: chain({ status: "archived" }) }),
      [`POST /v1/app/chains/${CHN}/unarchive`]: Response.json({ chain: chain() }),
    });
    expect(await h.run(["chains", "archive", CHN])).toBe(0);
    expect(h.stdout()).toContain("Archived");
    expect(await h.run(["chains", "unarchive", CHN])).toBe(0);
    expect(h.stdout()).toContain("is active again");
    expect(h.calls.map((call) => call.path)).toEqual([`/v1/app/chains/${CHN}/archive`, `/v1/app/chains/${CHN}/unarchive`]);
  });

  it("a company-wide share prints the confirmation link and what it changes, and does not claim the chain is shared", async () => {
    const h = await agentsCli({ [`PUT /v1/app/chains/${CHN}/shares`]: Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["Shares Triage with everyone in your company, who can then run it"] }, { status: 202 }) });
    const file = await h.file("shares.json", [{ principal: { kind: "org" }, level: "use" }]);
    expect(await h.run(["chains", "share", CHN, "--file", file])).toBe(0);
    expect(h.stdout()).toContain(CONFIRM);
    expect(h.stdout()).toContain("Shares Triage with everyone in your company, who can then run it");
    expect(h.stdout()).not.toContain("is now shared");
  });

  it("shares from a file", async () => {
    const h = await agentsCli({ [`PUT /v1/app/chains/${CHN}/shares`]: Response.json({ shares: [{ principal: { kind: "org" }, level: "view" }] }) });
    const shares = [{ principal: { kind: "org" }, level: "view" }];
    const file = await h.file("shares.json", shares);
    expect(await h.run(["chains", "share", CHN, "--file", file])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, shares });
    expect(h.stdout()).toContain("shared with 1 principal");
    expect(await h.run(["chains", "share", CHN, "--file", await h.file("object.json", {})])).not.toBe(0);
  });

  it("quotes ids safely in the path and refuses . and ..", async () => {
    const h = await agentsCli({});
    expect(await h.run(["chains", "show", ".."])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});
