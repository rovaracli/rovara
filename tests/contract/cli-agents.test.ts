// Plan 3 Task 35a: `agentx agents | project agents | project connectors | skills | approvals | org sources | org guardrails` against a fake control
// plane: the requests each command sends, what it prints, that a broker's refusal is printed as the broker wrote it, and that nothing here decides
// an approval (R66): the person approves or declines on the confirmation page.
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createCliProgram } from "../../packages/cli/src/main.js";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const AGT = "agt_aaaaaaaaaaaaaaaaaaaa";
const APR = "apr_bbbbbbbbbbbbbbbbbbbb";
const DEV = "d".repeat(64);
const CELL_URL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const CONFIRM = `${CELL_URL}/v1/app/approve/apr_bbbbbbbbbbbbbbbbbbbb`;
const agent = (extra: Record<string, unknown> = {}) => ({
  agentId: AGT, name: "Triage helper", description: "", builtin: false, owner: { kind: "member", developerId: DEV }, latestVersion: 2, currentVersion: 2,
  draftRevision: 4, status: "active", access: "manage", createdBy: DEV, createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z", ...extra,
});
const draft = (revision = 4) => ({ agentId: AGT, revision, overlay: { instructions: "old" }, updatedBy: DEV, updatedAt: "2026-10-22T09:00:00.000Z" });
const members = Response.json({ members: [{ developerId: DEV, name: "Maya", email: "maya@acme.dev", role: "admin", joinedAt: "2026-10-01T00:00:00.000Z", identities: ["cloud"] }] });
const CONFLICT = "AGENT_REVISION_CONFLICT: Someone else changed this agent's draft. Reload it and make your change again.";

describe("agentx agents list, show, versions and diff", () => {
  it("lists the agents of a scope or a project, and prints JSON with --json", async () => {
    const h = await agentsCli({
      "GET /v1/app/agents?scope=shared": Response.json({ agents: [agent()] }),
      "GET /v1/app/agents?project=payments": Response.json({ agents: [agent(), { agentId: "code-reviewer", name: "Code reviewer", builtin: true, status: "active", pinnedVersion: 1, latestVersion: 2, access: "use" }] }),
    });
    expect(await h.run(["agents", "list", "--shared"])).toBe(0);
    expect(h.stdout()).toContain(AGT);
    expect(h.stdout()).toContain("Triage helper");
    expect(await h.run(["--json", "agents", "list", "--project", "payments"])).toBe(0);
    expect(h.calls.map((call) => `${call.method} ${call.path}${call.query}`)).toEqual(["GET /v1/app/agents?scope=shared", "GET /v1/app/agents?project=payments"]);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { agents: [{ agentId: AGT }, { agentId: "code-reviewer", builtin: true }] } });
  });

  it("refuses two scopes at once without asking anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["agents", "list", "--mine", "--builtin"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("shows one agent, its versions, and a diff between two versions", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}`]: Response.json({ agent: agent(), current: { version: 2, changed: false }, suggestedMaxPerRunUsd: 3 }),
      [`GET /v1/app/agents/${AGT}/versions`]: Response.json({ versions: [{ version: 1, name: "Triage helper", digest: "a".repeat(64), publishedBy: DEV, publishedAt: "2026-10-20T00:00:00.000Z", current: false }, { version: 2, name: "Triage helper", digest: "b".repeat(64), publishedBy: DEV, publishedAt: "2026-10-21T00:00:00.000Z", current: true, note: "tighter" }] }),
      [`GET /v1/app/agents/${AGT}/diff?from=1&to=draft`]: Response.json({ from: 1, to: "draft", changes: [{ path: "instructions", before: "old", after: "new" }], lessSafe: [] }),
    });
    expect(await h.run(["agents", "show", AGT])).toBe(0);
    expect(await h.run(["agents", "versions", AGT])).toBe(0);
    expect(await h.run(["agents", "diff", AGT, "1", "draft"])).toBe(0);
    expect(h.stdout()).toContain("tighter");
    expect(h.stdout()).toContain("instructions");
    expect(h.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });
});

describe("agentx agents versions and run against the owner's OK for a looser older version (owner decision 2026-10-22)", () => {
  it("marks each version as the one that runs now, the same or safer, or less safe and needing the owner's OK", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/versions`]: Response.json({ versions: [
        { version: 1, digest: "a".repeat(64), publishedBy: DEV, publishedAt: "2026-10-19T00:00:00.000Z", current: false, safety: "less_safe", needsOwnerOk: true, lessSafe: ["Lets the agent change things in every linear connector (read and write)"] },
        { version: 2, digest: "b".repeat(64), publishedBy: DEV, publishedAt: "2026-10-20T00:00:00.000Z", current: false, safety: "same_or_safer", needsOwnerOk: false },
        { version: 3, digest: "c".repeat(64), publishedBy: DEV, publishedAt: "2026-10-21T00:00:00.000Z", current: true, safety: "current", needsOwnerOk: false },
      ] }),
    });
    expect(await h.run(["agents", "versions", AGT])).toBe(0);
    const lines = h.stdout().split("\n");
    expect(lines.find((line) => line.includes("v1"))).toContain("less safe than the current version, needs the owner's OK");
    expect(lines.find((line) => line.includes("v2"))).toContain("same or safer");
    expect(lines.find((line) => line.includes("v3"))).toContain("(runs now)");
    expect(lines.find((line) => line.includes("v3"))).not.toContain("same or safer");
  });

  it("says a run of a looser older version waits for the owner, with the link, instead of reporting a task", async () => {
    const h = await agentsCli({
      [`POST /v1/app/agents/${AGT}/runs`]: new Response(JSON.stringify({ status: "NEEDS_OWNER_APPROVAL", confirmUrl: CONFIRM, changes: ["Runs version 1 of Triage helper on payments, which is less safe than the version that runs now (version 3)"] }), { status: 202, headers: { "content-type": "application/json" } }),
    });
    expect(await h.run(["agents", "run", AGT, "--project", "payments", "--input", "go", "--version", "1"])).toBe(0);
    expect(h.stdout()).toContain("waits for the agent's owner to OK it");
    expect(h.stdout()).toContain(CONFIRM);
    expect(h.stdout()).not.toContain("Started");
  });
});

describe("agentx agents create", () => {
  it("creates a member's agent that extends another", async () => {
    const h = await agentsCli({ "POST /v1/app/agents": Response.json({ agent: agent() }, { status: 201 }) });
    expect(await h.run(["agents", "create", "--name", "Triage helper", "--extends", "code-reviewer"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/agents", query: "", body: { requestId: expect.stringMatching(UUID) as string, name: "Triage helper", extends: "code-reviewer" } }]);
    expect(h.stdout()).toContain(AGT);
  });

  it("creates a project's agent with its accountable maintainer, named by email", async () => {
    const h = await agentsCli({ "GET /v1/app/org/members": members, "POST /v1/app/agents": Response.json({ agent: agent({ owner: { kind: "project", project: "payments" } }) }, { status: 201 }) });
    expect(await h.run(["agents", "create", "--name", "Payments bot", "--project-owner", "payments", "--accountable", "MAYA@acme.dev"])).toBe(0);
    expect(h.calls.at(-1)!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, name: "Payments bot", owner: { kind: "project", project: "payments" }, accountable: { developerId: DEV } });
  });

  it("refuses --accountable without --project-owner before sending anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["agents", "create", "--name", "X", "--accountable", "maya@acme.dev"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx agents draft", () => {
  it("draft get prints the draft's overlay and revision", async () => {
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft() }) });
    expect(await h.run(["agents", "draft", "get", AGT])).toBe(0);
    expect(h.stdout()).toContain("revision 4");
    expect(h.stdout()).toContain("\"instructions\": \"old\"");
  });

  it("draft set reads the revision first and sends it as expectedRevision with the overlay from the file", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(4) }),
      [`PUT /v1/app/agents/${AGT}/draft`]: Response.json({ draft: { ...draft(5), overlay: { instructions: "new" } } }),
    });
    const overlay = await h.file("overlay.json", { instructions: "new" });
    expect(await h.run(["agents", "draft", "set", AGT, "--file", overlay])).toBe(0);
    expect(h.calls).toEqual([
      { method: "GET", path: `/v1/app/agents/${AGT}/draft`, query: "", body: undefined },
      { method: "PUT", path: `/v1/app/agents/${AGT}/draft`, query: "", body: { requestId: expect.stringMatching(UUID) as string, expectedRevision: 4, overlay: { instructions: "new" } } },
    ]);
    expect(h.stdout()).toContain("revision 5");
  });

  it("a 409 exits 1 and prints the broker's message exactly", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(4) }),
      [`PUT /v1/app/agents/${AGT}/draft`]: Response.json({ error: { code: "AGENT_REVISION_CONFLICT", message: CONFLICT } }, { status: 409 }),
    });
    const overlay = await h.file("overlay.json", { instructions: "new" });
    expect(await h.run(["agents", "draft", "set", AGT, "--file", overlay])).toBe(1);
    expect(h.stderr()).toBe(`${CONFLICT}\n`);
    expect(h.stdout()).toBe("");
  });

  it("refuses a file that is not a JSON object, sending nothing", async () => {
    const h = await agentsCli({});
    const bad = await h.file("bad.json", "not json");
    expect(await h.run(["agents", "draft", "set", AGT, "--file", bad])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx agents publish, rollback, update-base, adopt, share, archive, accountable", () => {
  it("publish sends the draft's revision and a note; a change waiting on the page prints its link and exits 0", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(4) }),
      [`POST /v1/app/agents/${AGT}/publish`]: Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["lets the agent write to Linear"] }, { status: 202 }),
    });
    expect(await h.run(["agents", "publish", AGT, "--note", "tighter"])).toBe(0);
    expect(h.calls.at(-1)!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, expectedRevision: 4, note: "tighter" });
    expect(h.stdout()).toContain(CONFIRM);
    expect(h.stdout()).toContain("lets the agent write to Linear");
  });

  it("publish prints the new version when it applies at once", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(4) }),
      [`POST /v1/app/agents/${AGT}/publish`]: Response.json({ version: { version: 3 }, agent: agent({ currentVersion: 3 }) }),
    });
    expect(await h.run(["agents", "publish", AGT])).toBe(0);
    expect(h.stdout()).toContain("version 3");
  });

  it("rollback, update-base and adopt send what each route takes", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(7) }),
      [`POST /v1/app/agents/${AGT}/rollback`]: Response.json({ agent: agent({ currentVersion: 1 }) }),
      [`POST /v1/app/agents/${AGT}/update-base`]: Response.json({ draft: draft(8), changes: [] }),
      "POST /v1/app/agents/code-reviewer/adopt": Response.json({ pinnedVersion: 2, changes: [] }),
    });
    expect(await h.run(["agents", "rollback", AGT, "1"])).toBe(0);
    expect(await h.run(["agents", "update-base", AGT])).toBe(0);
    expect(await h.run(["agents", "adopt", "code-reviewer", "2"])).toBe(0);
    const writes = h.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => [call.path, call.body])).toEqual([
      [`/v1/app/agents/${AGT}/rollback`, { requestId: expect.stringMatching(UUID) as string, version: 1 }],
      [`/v1/app/agents/${AGT}/update-base`, { requestId: expect.stringMatching(UUID) as string, expectedRevision: 7 }],
      ["/v1/app/agents/code-reviewer/adopt", { requestId: expect.stringMatching(UUID) as string, version: 2 }],
    ]);
  });

  it("share sends the shares from the file; archive and unarchive send a request id", async () => {
    const h = await agentsCli({
      [`PUT /v1/app/agents/${AGT}/shares`]: Response.json({ shares: [{ principal: { kind: "org" }, level: "use" }] }),
      [`POST /v1/app/agents/${AGT}/archive`]: Response.json({ agent: agent({ status: "archived" }) }),
      [`POST /v1/app/agents/${AGT}/unarchive`]: Response.json({ agent: agent() }),
    });
    const shares = await h.file("shares.json", [{ principal: { kind: "org" }, level: "use" }]);
    expect(await h.run(["agents", "share", AGT, "--file", shares])).toBe(0);
    expect(await h.run(["agents", "archive", AGT])).toBe(0);
    expect(await h.run(["agents", "unarchive", AGT])).toBe(0);
    expect(h.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", `/v1/app/agents/${AGT}/shares`, { requestId: expect.stringMatching(UUID) as string, shares: [{ principal: { kind: "org" }, level: "use" }] }],
      ["POST", `/v1/app/agents/${AGT}/archive`, { requestId: expect.stringMatching(UUID) as string }],
      ["POST", `/v1/app/agents/${AGT}/unarchive`, { requestId: expect.stringMatching(UUID) as string }],
    ]);
  });

  it("accountable names the person by email and sends their developer ID", async () => {
    const h = await agentsCli({ "GET /v1/app/org/members": members, [`PUT /v1/app/agents/${AGT}/accountable`]: Response.json({ accountable: { developerId: DEV } }) });
    expect(await h.run(["agents", "accountable", AGT, "maya@acme.dev"])).toBe(0);
    expect(h.calls.at(-1)).toEqual({ method: "PUT", path: `/v1/app/agents/${AGT}/accountable`, query: "", body: { requestId: expect.stringMatching(UUID) as string, accountable: { developerId: DEV } } });
    expect(h.stdout()).toContain("Maya");
  });
});

describe("agentx agents run", () => {
  const task = { taskId: "44444444-4444-4444-8444-444444444444", title: "Triage", project: "payments", status: "RUNNING", startingRevision: 3, client: "Rovara CLI", shared: false, createdAt: "2026-10-22T09:00:00.000Z", updatedAt: "2026-10-22T09:00:00.000Z", events: [] };

  it("--draft sends version \"draft\" and prints the task it started", async () => {
    const h = await agentsCli({ [`POST /v1/app/agents/${AGT}/runs`]: Response.json({ task }, { status: 202 }) });
    expect(await h.run(["agents", "run", AGT, "--project", "payments", "--input", "Look at the failing build", "--draft"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/agents/${AGT}/runs`, query: "", body: { requestId: expect.stringMatching(UUID) as string, project: "payments", version: "draft", input: { text: "Look at the failing build" } } }]);
    expect(h.stdout()).toContain(task.taskId);
  });

  it("--version sends that version; without either it sends none", async () => {
    const h = await agentsCli({ [`POST /v1/app/agents/${AGT}/runs`]: Response.json({ task }, { status: 202 }) });
    // The program's own --version is not taken for the run's, wherever the program's options stand.
    expect(await h.run(["--env", "staging", "agents", "run", AGT, "--project", "payments", "--input", "go", "--version", "2"])).toBe(0);
    expect(await h.run(["agents", "run", AGT, "--project", "payments", "--input", "go"])).toBe(0);
    expect((h.calls[0]!.body as Record<string, unknown>).version).toBe(2);
    expect(h.calls[1]!.body).not.toHaveProperty("version");
  });

  it("refuses --draft with --version, or no --input, before sending anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["agents", "run", AGT, "--project", "payments", "--input", "go", "--draft", "--version", "2"])).not.toBe(0);
    expect(await h.run(["agents", "run", AGT, "--project", "payments"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx project agents, connectors and comment-triggers", () => {
  it("adds and removes an agent on a project's roster", async () => {
    const h = await agentsCli({
      [`PUT /v1/app/projects/payments/agents/${AGT}`]: Response.json({ agent: { agentId: AGT, name: "Triage helper" } }),
      [`DELETE /v1/app/projects/payments/agents/${AGT}`]: Response.json({ removed: true }),
    });
    expect(await h.run(["project", "agents", "add", "payments", AGT])).toBe(0);
    expect(await h.run(["project", "agents", "remove", "payments", AGT])).toBe(0);
    expect(h.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", `/v1/app/projects/payments/agents/${AGT}`, { requestId: expect.stringMatching(UUID) as string }],
      ["DELETE", `/v1/app/projects/payments/agents/${AGT}`, { requestId: expect.stringMatching(UUID) as string }],
    ]);
  });

  it("lists connectors; set and remove send the revision the list showed", async () => {
    const connectors = Response.json({ revision: 9, connectors: [{ name: "linear", type: "linear", connectionId: "con_aaaaaaaaaaaaaaaaaaaa", scopes: [], tools: [{ name: "create_issue", access: "write" }], status: "connected" }] });
    const h = await agentsCli({
      "GET /v1/app/projects/payments/connectors": connectors,
      "PUT /v1/app/projects/payments/connectors/linear": Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["create_issue may write"] }, { status: 202 }),
      "DELETE /v1/app/projects/payments/connectors/linear": Response.json({ removed: { name: "linear" }, revision: 10 }),
    });
    expect(await h.run(["project", "connectors", "list", "payments"])).toBe(0);
    expect(h.stdout()).toContain("create_issue");
    const file = await h.file("linear.json", { type: "linear", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", tools: [{ name: "create_issue", access: "write" }] });
    expect(await h.run(["project", "connectors", "set", "payments", "linear", "--file", file])).toBe(0);
    expect(h.stdout()).toContain(CONFIRM);
    expect(await h.run(["project", "connectors", "remove", "payments", "linear"])).toBe(0);
    const writes = h.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.body)).toEqual([
      { requestId: expect.stringMatching(UUID) as string, expectedRevision: 9, connector: { type: "linear", credentialRef: "con_aaaaaaaaaaaaaaaaaaaa", tools: [{ name: "create_issue", access: "write" }], name: "linear" } },
      { requestId: expect.stringMatching(UUID) as string, expectedRevision: 9 },
    ]);
  });

  const scan = { project: "payments", repositories: [{ repository: "acme/payments", triggers: true, failedClosed: false, digest: "c".repeat(64), files: [".github/workflows/ci.yml", ".github/workflows/bot.yml"] }], coverage: "Only GitHub Actions workflows are read." };

  it("comment-triggers show prints the scan's files and digest", async () => {
    const h = await agentsCli({ "GET /v1/app/projects/payments/connectors/github/comment-triggers?repository=acme%2Fpayments": Response.json(scan) });
    expect(await h.run(["project", "connectors", "comment-triggers", "show", "payments", "acme/payments"])).toBe(0);
    expect(h.stdout()).toContain(".github/workflows/bot.yml");
    expect(h.stdout()).toContain("c".repeat(64));
  });

  it("comment-triggers opt-out sends the shown digest as expectedDigest and prints the confirmation link", async () => {
    const h = await agentsCli({
      "GET /v1/app/projects/payments/connectors/github/comment-triggers?repository=acme%2Fpayments": Response.json(scan),
      "PUT /v1/app/projects/payments/connectors/github/comment-triggers": Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["agents may comment"] }, { status: 202 }),
    });
    expect(await h.run(["project", "connectors", "comment-triggers", "opt-out", "payments", "acme/payments", "--reason", "the bot ignores agent comments"])).toBe(0);
    expect(h.calls.at(-1)).toEqual({
      method: "PUT", path: "/v1/app/projects/payments/connectors/github/comment-triggers", query: "",
      body: { requestId: expect.stringMatching(UUID) as string, repository: "acme/payments", expectedDigest: "c".repeat(64), reason: "the bot ignores agent comments" },
    });
    expect(h.stdout()).toContain(CONFIRM);
  });

  it("comment-triggers opt-out needs a reason", async () => {
    const h = await agentsCli({});
    expect(await h.run(["project", "connectors", "comment-triggers", "opt-out", "payments", "acme/payments"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx skills", () => {
  it("adds a SKILL.md from a file and lists the org's skills", async () => {
    const h = await agentsCli({
      "POST /v1/app/skills": Response.json({ skill: { skillId: "skl_aaaaaaaaaaaaaaaaaaaa", name: "triage", description: "How we triage" } }, { status: 201 }),
      "GET /v1/app/skills": Response.json({ skills: [{ skillId: "skl_aaaaaaaaaaaaaaaaaaaa", name: "triage", description: "How we triage" }] }),
    });
    const content = "---\nname: triage\ndescription: How we triage\n---\nSteps.\n";
    const file = await h.file("SKILL.md", content);
    expect(await h.run(["skills", "add", "--file", file])).toBe(0);
    expect(await h.run(["skills", "list"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, content });
    expect(h.stdout()).toContain("skl_aaaaaaaaaaaaaaaaaaaa");
    expect(h.stdout()).toContain("How we triage");
  });
});

describe("agentx approvals (R66: the CLI never decides)", () => {
  const pending = { approvalId: APR, kind: "write", status: "PENDING", createdAt: "2026-10-22T09:00:00.000Z", expiresAt: "2026-10-23T09:00:00.000Z", confirmUrl: CONFIRM, summary: "Create a Linear issue", connector: "linear", tool: "create_issue", project: "payments" };

  it("list prints each pending approval with its summary and link", async () => {
    const h = await agentsCli({ "GET /v1/app/approvals?status=PENDING": Response.json({ approvals: [pending] }) });
    expect(await h.run(["approvals", "list"])).toBe(0);
    expect(h.stdout()).toContain(APR);
    expect(h.stdout()).toContain("Create a Linear issue");
  });

  it("show prints the full arguments and the confirmUrl", async () => {
    const args = { title: "Flaky retry test", description: "x".repeat(400), labels: ["bug", "ci"] };
    const h = await agentsCli({ [`GET /v1/app/approvals/${APR}`]: Response.json({ approval: { ...pending, arguments: args, argumentsHash: "e".repeat(64) } }) });
    expect(await h.run(["approvals", "show", APR])).toBe(0);
    expect(h.stdout()).toContain(JSON.stringify(args, null, 2));
    expect(h.stdout()).toContain(CONFIRM);
  });

  it("open asks for the confirmation link, opens or prints it, and sends no decision", async () => {
    const ticketed = `${CONFIRM}?ticket=t1`;
    const h = await agentsCli({ [`POST /v1/app/approvals/${APR}/confirm-link`]: Response.json({ confirmUrl: ticketed, ticketed: true }) });
    expect(await h.run(["approvals", "open", APR, "--no-browser"])).toBe(0);
    expect(h.stdout()).toContain(ticketed);
    expect(h.opened).toEqual([]);
    expect(await h.run(["approvals", "open", APR])).toBe(0);
    expect(h.opened).toEqual([ticketed]);
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST /v1/app/approvals/${APR}/confirm-link`, `POST /v1/app/approvals/${APR}/confirm-link`]);
    expect(h.calls.every((call) => !call.path.endsWith("/decide"))).toBe(true);
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
  });

  it("has no approve, decline, deny or decide command anywhere", () => {
    const names: string[] = [];
    const walk = (command: Command, path: string[]): void => {
      for (const sub of command.commands) {
        names.push([...path, sub.name()].join(" "));
        walk(sub, [...path, sub.name()]);
      }
    };
    walk(createCliProgram(), []);
    expect(names).toContain("approvals open");
    // The operator's review of egress domains (an admin sign-in, not a person's agent approval) predates the agent platform and stays. So does the administrator's approval of a
    // project's E2E setup (`project setup-approve`, M1.3: an admin sign-in deciding a project's test setup, not an agent's approval). So does the customer administrators' approval
    // of a signed release bundle (`bundle approve`, Enterprise upgrades): a human administrator on their own install, with their own AWS credentials, pinning the hash of what the Rovara
    // operator may deploy. It decides nothing for an agent and carries no agent approval id. So does `admin task lessons-replay approve` (lane 7): an administrator's sign-in approving the waiting plan
    // of a marked replay copy made to measure the lessons (the route refuses anything that is not a replay copy). It is not an agent's approval and carries no agent approval id.
    expect(names.filter((name) => /\b(approve|decline|deny|decide|reject|accept)\b/.test(name))).toEqual(["bundle approve", "admin egress approve", "admin egress reject", "admin task lessons-replay approve", "project setup-approve"]);
    expect(names.filter((name) => name.startsWith("approvals ")).sort()).toEqual(["approvals list", "approvals open", "approvals show"]);
    expect(names.filter((name) => name.startsWith("project connectors comment-triggers ")).sort()).toEqual(["project connectors comment-triggers opt-out", "project connectors comment-triggers show"]);
  });
});

describe("agentx org comment-triggers, guardrails and sources", () => {
  it("org comment-triggers list is the existing command, still there", async () => {
    const h = await agentsCli({ "GET /v1/app/org/agent-guardrails": Response.json({ guardrails: {}, revision: 1, commentTriggerOptOuts: [] }) });
    expect(await h.run(["org", "comment-triggers", "list"])).toBe(0);
  });

  it("guardrails show prints the document; set reads the revision first and prints a waiting change's link", async () => {
    const h = await agentsCli({
      "GET /v1/app/org/agent-guardrails": Response.json({ guardrails: { maxAgentMonthlyUsd: 100 }, revision: 6, commentTriggerOptOuts: [] }),
      "PUT /v1/app/org/agent-guardrails": Response.json({ status: "NEEDS_CONFIRMATION", confirmUrl: CONFIRM, changes: ["raises the monthly ceiling"] }, { status: 202 }),
    });
    expect(await h.run(["org", "guardrails", "show"])).toBe(0);
    expect(h.stdout()).toContain("maxAgentMonthlyUsd");
    const file = await h.file("guardrails.json", { maxAgentMonthlyUsd: 500 });
    expect(await h.run(["org", "guardrails", "set", "--file", file])).toBe(0);
    expect(h.calls.at(-1)!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, expectedRevision: 6, guardrails: { maxAgentMonthlyUsd: 500 } });
    expect(h.stdout()).toContain(CONFIRM);
  });

  const KEY = "sk-ant-api03-SECRETVALUE0123456789";
  const source = { kind: "anthropic", label: "Acme Anthropic", models: ["claude-sonnet-5-5"] };

  it("sources add refuses a --key flag and sends nothing", async () => {
    const h = await agentsCli({ "POST /v1/app/org/model-sources": Response.json({ sourceId: "src_x" }, { status: 201 }) });
    const file = await h.file("source.json", source);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key", KEY])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.stdout() + h.stderr()).not.toContain(KEY);
    expect(h.stderr()).toContain("--key-from-env");
  });

  it("sources add reads the key from the named environment variable, sends it once and never prints it", async () => {
    const h = await agentsCli({ "POST /v1/app/org/model-sources": Response.json({ sourceId: "src_aaaaaaaa" }, { status: 201 }) }, { env: { ACME_ANTHROPIC_KEY: KEY } });
    const file = await h.file("source.json", source);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", "ACME_ANTHROPIC_KEY"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: "/v1/app/org/model-sources", query: "", body: { requestId: expect.stringMatching(UUID) as string, source, apiKey: KEY } }]);
    expect(h.stdout() + h.stderr()).not.toContain(KEY);
    expect(h.stdout()).toContain("src_aaaaaaaa");
  });

  it("sources add refuses an unset or empty variable before sending", async () => {
    const h = await agentsCli({}, { env: { EMPTY: "" } });
    const file = await h.file("source.json", source);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", "MISSING"])).not.toBe(0);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", "EMPTY"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("sources list, remove, order and check", async () => {
    const h = await agentsCli({
      "GET /v1/app/org/model-sources": Response.json({ sources: [{ sourceId: "src_aaaaaaaa", kind: "anthropic", label: "Acme Anthropic", models: ["claude-sonnet-5-5"], hasCredential: true, inOrder: true }], order: ["src_aaaaaaaa", "rovara"] }),
      "DELETE /v1/app/org/model-sources/src_aaaaaaaa": Response.json({ sourceId: "src_aaaaaaaa", removed: true }),
      "PUT /v1/app/org/model-sources-order": Response.json({ order: ["rovara", "src_aaaaaaaa"] }),
      "POST /v1/app/org/model-sources/src_aaaaaaaa/check": Response.json({ ok: true }),
    });
    expect(await h.run(["org", "sources", "list"])).toBe(0);
    expect(h.stdout()).toContain("Acme Anthropic");
    expect(await h.run(["org", "sources", "remove", "src_aaaaaaaa"])).toBe(0);
    expect(await h.run(["org", "sources", "order", "rovara", "src_aaaaaaaa"])).toBe(0);
    expect(await h.run(["org", "sources", "check", "src_aaaaaaaa"])).toBe(0);
    expect(h.calls.slice(1).map((call) => [call.method, call.path, call.body])).toEqual([
      ["DELETE", "/v1/app/org/model-sources/src_aaaaaaaa", { requestId: expect.stringMatching(UUID) as string }],
      ["PUT", "/v1/app/org/model-sources-order", { requestId: expect.stringMatching(UUID) as string, order: ["rovara", "src_aaaaaaaa"] }],
      ["POST", "/v1/app/org/model-sources/src_aaaaaaaa/check", undefined],
    ]);
  });
});

// Fix round 1 (review I1, M3–M5, M7, M9, M12–M14): text the server wrote is marked, not printed raw; a link is opened only when it is the
// cell's own confirmation page; IDs and names are checked before anything is sent.
describe("fix round 1: server text in a terminal (I1)", () => {
  const RLO = "\u202E";
  const CSI = "\u009B";
  const ZWSP = "\u200B";
  const hostile = `Create a Linear issue ${RLO}eteled${CSI}2J${ZWSP}done`;
  const pending = { approvalId: APR, kind: "write", status: "PENDING", expiresAt: "2026-10-23T09:00:00.000Z", confirmUrl: CONFIRM, summary: hostile, prompt: hostile, changes: [hostile] };
  const marked = (text: string) => {
    expect(text).toContain("[U+202E]");
    expect(text).toContain("[U+009B]");
    expect(text).toContain("[U+200B]");
    expect(text).not.toMatch(/[\u202E\u009B\u200B]/);
  };

  it("marks RLO, U+009B and U+200B in an approval's summary in approvals list and show", async () => {
    const h = await agentsCli({
      "GET /v1/app/approvals?status=PENDING": Response.json({ approvals: [pending] }),
      [`GET /v1/app/approvals/${APR}`]: Response.json({ approval: pending }),
    });
    expect(await h.run(["approvals", "list"])).toBe(0);
    marked(h.stdout());
    h.out.length = 0;
    expect(await h.run(["approvals", "show", APR])).toBe(0);
    marked(h.stdout());
  });

  it("marks them in a 409's message on stderr, and still hides a token", async () => {
    const h = await agentsCli({
      [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: draft(4) }),
      [`PUT /v1/app/agents/${AGT}/draft`]: Response.json({ error: { code: "AGENT_REVISION_CONFLICT", message: `${hostile} agxr_${"z".repeat(43)}` } }, { status: 409 }),
    });
    const overlay = await h.file("overlay.json", { instructions: "new" });
    expect(await h.run(["agents", "draft", "set", AGT, "--file", overlay])).toBe(1);
    marked(h.stderr());
    expect(h.stderr()).toContain("[hidden]");
    expect(h.stderr()).not.toContain("agxr_");
  });

  it("cuts a very long message with a visible marker (M8)", async () => {
    const h = await agentsCli({ [`GET /v1/app/approvals/${APR}`]: Response.json({ error: { code: "NOT_FOUND", message: "x".repeat(900) } }, { status: 404 }) });
    expect(await h.run(["approvals", "show", APR])).not.toBe(0);
    expect(h.stderr()).toContain("...[truncated]");
  });
});

describe("fix round 1: smaller findings", () => {
  it("approvals open opens only an https link to this cell's approval page (M3)", async () => {
    for (const link of ["file:///etc/passwd", "https://evil.example/v1/app/approve/apr_bbbbbbbbbbbbbbbbbbbb", "-x", `${CELL_URL}/v1/app/other`]) {
      const h = await agentsCli({ [`POST /v1/app/approvals/${APR}/confirm-link`]: Response.json({ confirmUrl: link, ticketed: true }) });
      expect(await h.run(["approvals", "open", APR])).toBe(0);
      expect(h.opened, link).toEqual([]);
    }
  });

  it("refuses an ID that is . or .. before sending anything (M7)", async () => {
    const h = await agentsCli({});
    expect(await h.run(["approvals", "open", ".."])).not.toBe(0);
    expect(await h.run(["agents", "archive", "."])).not.toBe(0);
    expect(await h.run(["project", "agents", "add", "..", AGT])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("agents run --version=2 runs version 2 (M9)", async () => {
    const task = { taskId: "44444444-4444-4444-8444-444444444444", status: "RUNNING" };
    const h = await agentsCli({ [`POST /v1/app/agents/${AGT}/runs`]: Response.json({ task }, { status: 202 }) });
    expect(await h.run(["agents", "run", AGT, "--project", "payments", "--input", "go", "--version=2"])).toBe(0);
    expect((h.calls[0]!.body as Record<string, unknown>).version).toBe(2);
  });

  it("draft get names the agent (M14)", async () => {
    const stored: Record<string, unknown> = draft();
    delete stored.agentId;
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/draft`]: Response.json({ draft: stored }) });
    expect(await h.run(["agents", "draft", "get", AGT])).toBe(0);
    expect(h.stdout()).toContain(`Draft of ${AGT} at revision 4`);
  });

  it("connectors set fills in the connector's name, and refuses a file naming another (M12)", async () => {
    const h = await agentsCli({
      "GET /v1/app/projects/payments/connectors": Response.json({ revision: 9, connectors: [] }),
      "PUT /v1/app/projects/payments/connectors/linear": Response.json({ revision: 10 }),
    });
    const file = await h.file("linear.json", { type: "linear" });
    expect(await h.run(["project", "connectors", "set", "payments", "linear", "--file", file])).toBe(0);
    expect((h.calls.at(-1)!.body as { connector: unknown }).connector).toEqual({ type: "linear", name: "linear" });
    const other = await h.file("other.json", { type: "linear", name: "jira" });
    const before = h.calls.length;
    expect(await h.run(["project", "connectors", "set", "payments", "linear", "--file", other])).not.toBe(0);
    expect(h.calls.length).toBe(before);
  });

  it("a connector change still being applied is not reported as saved (M13)", async () => {
    const h = await agentsCli({
      "GET /v1/app/projects/payments/connectors": Response.json({ revision: 9, connectors: [] }),
      "PUT /v1/app/projects/payments/connectors/linear": Response.json({ status: "EXECUTING" }, { status: 202 }),
    });
    const file = await h.file("linear.json", { type: "linear", name: "linear" });
    expect(await h.run(["project", "connectors", "set", "payments", "linear", "--file", file])).toBe(0);
    expect(h.stdout()).not.toContain("Saved");
    expect(h.stdout()).toContain("being applied");
  });

  const KEY = "sk-ant-api03-SECRETVALUE0123456789";
  it("--json never prints a key the server echoed (M4)", async () => {
    const h = await agentsCli({ "POST /v1/app/org/model-sources": Response.json({ sourceId: "src_aaaaaaaa", apiKey: KEY, message: `saved ${KEY}` }, { status: 201 }) }, { env: { ACME_KEY: KEY } });
    const file = await h.file("source.json", { kind: "anthropic", label: "Acme" });
    expect(await h.run(["--json", "org", "sources", "add", "--file", file, "--key-from-env", "ACME_KEY"])).toBe(0);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", "ACME_KEY"])).toBe(0);
    expect(h.stdout()).not.toContain(KEY);
  });

  it("does not repeat a --key-from-env value that may be the key itself (M5)", async () => {
    const pasted = "sk_live_abcdefABCDEF0123456789";
    const h = await agentsCli({}, { env: {} });
    const file = await h.file("source.json", { kind: "anthropic", label: "Acme" });
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", pasted])).not.toBe(0);
    expect(h.stdout() + h.stderr()).not.toContain(pasted);
    expect(await h.run(["org", "sources", "add", "--file", file, "--key-from-env", "ACME_KEY"])).not.toBe(0);
    expect(h.stderr()).toContain("ACME_KEY");
    expect(h.calls).toEqual([]);
  });
});
