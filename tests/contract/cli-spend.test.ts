// Plan 3 Task 35a: `agentx agents budget` and `agentx project ai set` against a fake control plane: the amounts each sends (a number, or null
// for "none"), what a request waiting on someone else prints, and the refusals made before anything is sent.
import { afterEach, describe, expect, it } from "vitest";
import { UUID, agentsCli, cleanHarnessDirs } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const AGT = "agt_aaaaaaaaaaaaaaaaaaaa";
const agent = { agentId: AGT, name: "Triage helper", builtin: false, status: "active", monthlyBudgetUsd: 50, access: "manage" };

describe("agentx agents budget", () => {
  it("sends a monthly amount and clears the per-run limit with none", async () => {
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ agent }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "50", "--max-per-run", "none"])).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: `/v1/app/agents/${AGT}/budget`, query: "", body: { requestId: expect.stringMatching(UUID) as string, monthlyUsd: 50, maxPerRunUsd: null } }]);
    expect(h.stdout()).toContain("$50");
  });

  // Pins a Task 32 shape: at this commit the broker refuses an over-the-cap change with CONFIG_INVALID (its "TASK 32 SEAM" in
  // packages/broker/src/spend/settings.ts). Task 32 answers 202 { status: "NEEDS_ADMIN_APPROVAL", spendRequestId, message } instead, as here.
  it("answered 202 NEEDS_ADMIN_APPROVAL (Task 32), prints the broker's message and the spend request's id, and exits 0", async () => {
    const message = "Maya's agent budgets would total $500 a month, over the $200 limit for one person. I asked an org admin to approve it.";
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_cccccccccccccccccccc", message }, { status: 202 }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "500"])).toBe(0);
    expect(h.stdout()).toContain(message);
    expect(h.stdout()).toContain("spr_cccccccccccccccccccc");
    expect(await h.run(["--json", "agents", "budget", AGT, "--monthly", "500"])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { status: "NEEDS_ADMIN_APPROVAL", message, spendRequestId: "spr_cccccccccccccccccccc" } });
  });

  it("prints a refusal as the broker wrote it", async () => {
    const message = "CONFIG_INVALID: monthlyUsd: your company's guardrails allow at most $100 a month for one agent";
    const h = await agentsCli({ [`PUT /v1/app/agents/${AGT}/budget`]: Response.json({ error: { code: "CONFIG_INVALID", message } }, { status: 400 }) });
    expect(await h.run(["agents", "budget", AGT, "--monthly", "500"])).not.toBe(0);
    expect(h.stderr()).toBe(`${message}\n`);
  });

  it("refuses no amount, a negative one or a word other than none, before sending anything", async () => {
    const h = await agentsCli({});
    expect(await h.run(["agents", "budget", AGT])).not.toBe(0);
    expect(await h.run(["agents", "budget", AGT, "--monthly", "-5"])).not.toBe(0);
    expect(await h.run(["agents", "budget", AGT, "--max-per-run", "lots"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("agentx project ai set", () => {
  it("sends the budget, who pays and the planning limits", async () => {
    const answer = { settings: { monthlyBudgetUsd: 300, projectPays: true, planningLimitUsd: { QUICK: 2, FULL: 5 } }, revision: 3, effective: { sourceOrder: ["rovara"], planningLimitUsd: { QUICK: 2, FULL: 5 } } };
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json(answer) });
    expect(await h.run(["project", "ai", "set", "payments", "--budget", "300", "--project-pays", "on", "--planning-quick", "2", "--planning-full", "5"])).toBe(0);
    expect(h.calls).toEqual([{
      method: "PUT", path: "/v1/app/projects/payments/ai", query: "",
      body: { requestId: expect.stringMatching(UUID) as string, monthlyBudgetUsd: 300, projectPays: true, planningLimitUsd: { QUICK: 2, FULL: 5 } },
    }]);
    expect(h.stdout()).toContain("revision 3");
  });

  it("clears the budget with none and turns project pays off", async () => {
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json({ settings: {}, revision: 4, effective: { sourceOrder: [], planningLimitUsd: { QUICK: 1, FULL: 3 } } }) });
    expect(await h.run(["project", "ai", "set", "payments", "--budget", "none", "--project-pays", "off"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, monthlyBudgetUsd: null, projectPays: false });
  });

  it("resets a planning limit to the default with none (review M11)", async () => {
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json({ settings: {}, revision: 5, effective: { sourceOrder: [], planningLimitUsd: { QUICK: 1, FULL: 3 } } }) });
    expect(await h.run(["project", "ai", "set", "payments", "--planning-quick", "none", "--planning-full", "4"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, planningLimitUsd: { QUICK: null, FULL: 4 } });
  });

  it("sends what a member may accept as a run limit when the project pays (owner decision 3), and none resets it to the default", async () => {
    const answer = { settings: { projectPays: true, memberAcceptRunLimitUpToUsd: 25 }, revision: 6, effective: { sourceOrder: [], planningLimitUsd: { QUICK: 1, FULL: 3 }, memberAcceptRunLimitUpToUsd: 25 } };
    const h = await agentsCli({ "PUT /v1/app/projects/payments/ai": Response.json(answer) });
    expect(await h.run(["project", "ai", "set", "payments", "--member-accept-run-limit", "25"])).toBe(0);
    expect(h.calls[0]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, memberAcceptRunLimitUpToUsd: 25 });
    expect(h.stdout()).toContain("a member accepts a run limit up to $25");
    expect(await h.run(["project", "ai", "set", "payments", "--member-accept-run-limit", "none"])).toBe(0);
    expect(h.calls[1]!.body).toEqual({ requestId: expect.stringMatching(UUID) as string, memberAcceptRunLimitUpToUsd: null });
  });

  it("refuses no setting, or --project-pays other than on or off, before sending", async () => {
    const h = await agentsCli({});
    expect(await h.run(["project", "ai", "set", "payments"])).not.toBe(0);
    expect(await h.run(["project", "ai", "set", "payments", "--project-pays", "yes"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });
});

// ---- Plan 3 Task 35b: what an agent and the company have spent, the spend requests, and a task's way past its limit.

const SPR = "spr_cccccccccccccccccccc";
const SPR_CONFIRM = `https://abc123.execute-api.us-west-2.amazonaws.com/v1/app/approve/${SPR}`;
const TASK = "44444444-4444-4444-8444-444444444444";

describe("agentx agents spend", () => {
  const spend = {
    month: "2026-10", totalUsd: 12.5, byOrigin: { person: 8, autonomous: 4.5, test: 0 },
    recentRuns: [{ taskId: TASK, project: "payments", origin: "person", usd: 3.25, lastAt: "2026-10-21T10:00:00.000Z" }],
    budget: { limitUsd: 50, spentUsd: 12.5 }, maxPerRunUsd: 5,
  };

  it("reads this month's spend and prints the total, the origins, the budget and the recent runs", async () => {
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/spend`]: Response.json(spend) });
    expect(await h.run(["agents", "spend", AGT])).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: `/v1/app/agents/${AGT}/spend`, query: "", body: undefined }]);
    const text = h.stdout();
    expect(text).toContain("2026-10");
    expect(text).toContain("$12.5");
    expect(text).toContain("$50");
    expect(text).toContain("$5");
    expect(text).toMatch(/person\s+\$8/);
    expect(text).toMatch(/autonomous\s+\$4\.5/);
    expect(text).toContain(TASK);
    expect(text).toContain("payments");
  });

  it("sends --month, and refuses a month that is not YYYY-MM before sending", async () => {
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/spend?month=2026-09`]: Response.json({ ...spend, month: "2026-09" }) });
    expect(await h.run(["agents", "spend", AGT, "--month", "2026-09"])).toBe(0);
    expect(h.calls[0]!.query).toBe("?month=2026-09");
    const before = h.calls.length;
    for (const bad of ["2026-13", "sept", "2026-9", "2026-09-01"]) expect(await h.run(["agents", "spend", AGT, "--month", bad]), bad).not.toBe(0);
    expect(h.calls).toHaveLength(before);
  });

  it("prints the broker's refusal as it wrote it", async () => {
    const message = "NOT_FOUND: no agent has that ID";
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/spend`]: Response.json({ error: { code: "NOT_FOUND", message } }, { status: 404 }) });
    expect(await h.run(["agents", "spend", AGT])).not.toBe(0);
    expect(h.stderr()).toBe(`${message}\n`);
  });

  it("is terminal-safe: a project name with a bidi override and a control sequence is marked, and --json is marked too", async () => {
    const evil = "pay\u202Ements\u009B2J\u200B";
    const body = { ...spend, recentRuns: [{ ...spend.recentRuns[0], project: evil }] };
    const h = await agentsCli({ [`GET /v1/app/agents/${AGT}/spend`]: Response.json(body) });
    expect(await h.run(["agents", "spend", AGT])).toBe(0);
    expect(h.stdout()).toContain("[U+202E]");
    expect(h.stdout()).toContain("[U+009B]");
    expect(h.stdout()).not.toMatch(/[\u202E\u009B\u200B]/);
    expect(await h.run(["--json", "agents", "spend", AGT])).toBe(0);
    expect(h.out.at(-1)).not.toMatch(/[\u202E\u009B\u200B]/);
  });
});

describe("agentx org spend", () => {
  const org = {
    month: "2026-10", totalUsd: 120.75, committedUsd: 4, limitUsd: 500,
    byProject: [{ project: "payments", spentUsd: 100, committedUsd: 4 }], byMember: [{ developerId: "a".repeat(64), spentUsd: 70 }],
    byAgent: [{ agentId: AGT, spentUsd: 40 }], bySource: [{ source: "rovara", spentUsd: 120.75 }], byModel: [{ model: "claude-sonnet-5-5", spentUsd: 120.75 }],
  };

  it("prints the month's total, the limit and each breakdown", async () => {
    const h = await agentsCli({ "GET /v1/app/org/spend": Response.json(org) });
    expect(await h.run(["org", "spend"])).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: "/v1/app/org/spend", query: "", body: undefined }]);
    const text = h.stdout();
    for (const wanted of ["2026-10", "$120.75", "$500", "payments", "$100", "a".repeat(64), AGT, "rovara", "claude-sonnet-5-5"]) expect(text, wanted).toContain(wanted);
  });

  it("sends --month, and --json prints the answer as data", async () => {
    const h = await agentsCli({ "GET /v1/app/org/spend?month=2026-09": Response.json({ ...org, month: "2026-09" }) });
    expect(await h.run(["--json", "org", "spend", "--month", "2026-09"])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { month: "2026-09", totalUsd: 120.75 } });
  });

  it("--ledger reads the month's settled lines and prints the cursor for the next page; --cursor sends it", async () => {
    const lines = [{ at: "2026-10-21T10:00:00.000Z", usd: 1.5, settledUsd: 1.25, finalized: true, model: "claude-sonnet-5-5", taskId: TASK, project: "payments", origin: "person" }];
    const next = "eyJzayI6IngifQ";
    const h = await agentsCli({
      "GET /v1/app/org/spend/ledger": Response.json({ month: "2026-10", lines, next }),
      [`GET /v1/app/org/spend/ledger?month=2026-10&cursor=${next}`]: Response.json({ month: "2026-10", lines: [] }),
    });
    expect(await h.run(["org", "spend", "--ledger"])).toBe(0);
    expect(h.calls[0]).toMatchObject({ path: "/v1/app/org/spend/ledger", query: "" });
    expect(h.stdout()).toContain("$1.25");
    expect(h.stdout()).toContain(TASK);
    expect(h.stdout()).toContain(`--cursor ${next}`);
    expect(await h.run(["org", "spend", "--ledger", "--month", "2026-10", "--cursor", next])).toBe(0);
    expect(h.calls.at(-1)!.query).toBe(`?month=2026-10&cursor=${next}`);
  });

  it("prints the cursor exactly as the broker sent it, even when it is shaped like a token, and not one that is not URL-safe base64 (review M3)", async () => {
    const odd = "agxr_AAAAbbbbCCCC-_09";
    const h = await agentsCli({ "GET /v1/app/org/spend/ledger": Response.json({ month: "2026-10", lines: [], next: odd }) });
    expect(await h.run(["org", "spend", "--ledger"])).toBe(0);
    expect(h.stdout()).toContain(`--cursor ${odd}`);
    const bad = await agentsCli({ "GET /v1/app/org/spend/ledger": Response.json({ month: "2026-10", lines: [], next: "abc def\u202E;rm" }) });
    expect(await bad.run(["org", "spend", "--ledger"])).toBe(0);
    expect(bad.stdout()).not.toContain("--cursor");
    expect(bad.stdout()).not.toContain("rm");
    expect(bad.stdout()).toContain("can't be paged");
  });

  it("refuses --cursor without --month, so a cursor is never applied to another month (review M3)", async () => {
    const h = await agentsCli({});
    expect(await h.run(["org", "spend", "--ledger", "--cursor", "abc"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("refuses a bad month, and --cursor without --ledger, before sending", async () => {
    const h = await agentsCli({});
    expect(await h.run(["org", "spend", "--month", "2026-00"])).not.toBe(0);
    expect(await h.run(["org", "spend", "--cursor", "abc"])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("prints the broker's refusal to a member as it wrote it", async () => {
    const message = "FORBIDDEN: Only an org owner or admin can see the company's spend.";
    const h = await agentsCli({ "GET /v1/app/org/spend": Response.json({ error: { code: "FORBIDDEN", message } }, { status: 403 }) });
    expect(await h.run(["org", "spend"])).not.toBe(0);
    expect(h.stderr()).toBe(`${message}\n`);
  });
});

describe("agentx spend-requests (R66: read and link only)", () => {
  const request = {
    spendRequestId: SPR, kind: "run_limit", status: "PENDING", amountUsd: 18, newLimitUsd: 20, taskId: TASK, reason: "Approving this plan sets a run limit of $20, which needs a project maintainer's approval.",
    requestedBy: { kind: "member", developerId: "b".repeat(64) }, approverRole: "project_maintainer", createdAt: "2026-10-22T09:00:00.000Z", expiresAt: "2026-10-29T09:00:00.000Z", confirmUrl: SPR_CONFIRM,
  };

  it("list prints each request with its kind, amount and reason, and says where to decide", async () => {
    const h = await agentsCli({ "GET /v1/app/spend-requests": Response.json({ spendRequests: [request] }) });
    expect(await h.run(["spend-requests", "list"])).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: "/v1/app/spend-requests", query: "", body: undefined }]);
    for (const wanted of [SPR, "run_limit", "$18", "$20", "needs a project maintainer", "agentx spend-requests open"]) expect(h.stdout(), wanted).toContain(wanted);
  });

  it("list says so when nothing waits", async () => {
    const h = await agentsCli({ "GET /v1/app/spend-requests": Response.json({ spendRequests: [] }) });
    expect(await h.run(["spend-requests", "list"])).toBe(0);
    expect(h.stdout()).toContain("No spend requests");
  });

  it("list is terminal-safe in the reason", async () => {
    const h = await agentsCli({ "GET /v1/app/spend-requests": Response.json({ spendRequests: [{ ...request, reason: "safe\u202Etxt.etadpu\u009B" }] }) });
    expect(await h.run(["spend-requests", "list"])).toBe(0);
    expect(h.stdout()).toContain("[U+202E]");
    expect(h.stdout()).toContain("[U+009B]");
    expect(h.stdout()).not.toMatch(/[\u202E\u009B]/);
  });

  it("open asks for the confirmation link, prints or opens it, and posts no decision", async () => {
    const ticketed = `${SPR_CONFIRM}?ticket=t1`;
    const h = await agentsCli({ [`POST /v1/app/spend-requests/${SPR}/confirm-link`]: Response.json({ confirmUrl: ticketed, ticketed: true }) });
    expect(await h.run(["spend-requests", "open", SPR, "--no-browser"])).toBe(0);
    expect(h.stdout()).toContain(ticketed);
    expect(h.opened).toEqual([]);
    expect(await h.run(["spend-requests", "open", SPR])).toBe(0);
    expect(h.opened).toEqual([ticketed]);
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual(Array(2).fill(`POST /v1/app/spend-requests/${SPR}/confirm-link`));
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
  });

  it("open never hands a browser a link that is not this cell's confirmation page, and refuses an ID that is ..", async () => {
    for (const link of ["file:///etc/passwd", `https://evil.example/v1/app/approve/${SPR}`, "-x"]) {
      const h = await agentsCli({ [`POST /v1/app/spend-requests/${SPR}/confirm-link`]: Response.json({ confirmUrl: link, ticketed: false }) });
      expect(await h.run(["spend-requests", "open", SPR])).toBe(0);
      expect(h.opened, link).toEqual([]);
    }
    const h = await agentsCli({});
    expect(await h.run(["spend-requests", "open", ".."])).not.toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("has list and open only: no command decides a spend request", async () => {
    const program = (await import("../../packages/cli/src/main.js")).createCliProgram();
    const group = program.commands.find((command) => command.name() === "spend-requests");
    expect(group?.commands.map((command) => command.name()).sort()).toEqual(["list", "open"]);
    expect(group?.commands.map((command) => command.name()).filter((name) => /approve|decline|deny|decide|reject|accept/.test(name))).toEqual([]);
  });
});

describe("agentx task continue-as-task and ask-run-limit", () => {
  it("continue-as-task posts a new request ID and prints where the task is now", async () => {
    const h = await agentsCli({ [`POST /v1/app/tasks/${TASK}/continue-as-task`]: Response.json({ task: { taskId: TASK, status: "RUNNING", project: "payments" } }) });
    expect(await h.run(["task", "continue-as-task", TASK])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/tasks/${TASK}/continue-as-task`, query: "", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.stdout()).toContain(TASK);
    // UX2 slice 2 (e6e8aebc1): the CLI says the status model's word, never the raw code.
    expect(h.stdout()).toContain("(Building)");
    expect(h.stdout()).not.toContain("RUNNING");
    expect(h.stdout()).toContain("normal task");
  });

  it("continue-as-task prints the broker's refusal as it wrote it, and refuses an ID that is .", async () => {
    const message = "CONFIG_INVALID: only a test run that reached its cap can continue as a normal task";
    const h = await agentsCli({ [`POST /v1/app/tasks/${TASK}/continue-as-task`]: Response.json({ error: { code: "CONFIG_INVALID", message } }, { status: 400 }) });
    expect(await h.run(["task", "continue-as-task", TASK])).not.toBe(0);
    expect(h.stderr()).toBe(`${message}\n`);
    expect(await h.run(["task", "continue-as-task", "."])).not.toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it("ask-run-limit asks again for the run limit of a plan whose request was denied or ran out, and prints the new request", async () => {
    const answer = { spendRequestId: SPR, created: true };
    const h = await agentsCli({ [`POST /v1/app/tasks/${TASK}/run-limit-request`]: Response.json(answer, { status: 201 }) });
    expect(await h.run(["task", "ask-run-limit", TASK])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/tasks/${TASK}/run-limit-request`, query: "", body: { requestId: expect.stringMatching(UUID) as string } }]);
    expect(h.stdout()).toContain(SPR);
    expect(h.stdout()).toContain("asked");
    expect(h.calls.every((call) => !call.path.includes("/decide"))).toBe(true);
  });

  it("ask-run-limit says when the request it found was already open, and prints a refusal as written", async () => {
    const open = { spendRequestId: SPR, created: false };
    const h = await agentsCli({ [`POST /v1/app/tasks/${TASK}/run-limit-request`]: Response.json(open) });
    expect(await h.run(["task", "ask-run-limit", TASK])).toBe(0);
    expect(h.stdout()).toContain("already");
    const message = "CONFIG_INVALID: this task is not waiting for a run limit";
    const refused = await agentsCli({ [`POST /v1/app/tasks/${TASK}/run-limit-request`]: Response.json({ error: { code: "CONFIG_INVALID", message } }, { status: 400 }) });
    expect(await refused.run(["task", "ask-run-limit", TASK])).not.toBe(0);
    expect(refused.stderr()).toBe(`${message}\n`);
  });

  it("the task group holds these two commands and nothing that decides", async () => {
    const program = (await import("../../packages/cli/src/main.js")).createCliProgram();
    expect(program.commands.find((command) => command.name() === "task")?.commands.map((command) => command.name()).sort()).toEqual(["ask-run-limit", "continue-as-task"]);
  });
});
