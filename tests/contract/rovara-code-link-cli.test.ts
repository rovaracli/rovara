// Plan 6 Task 20 (owner decision 2026-10-26): `agentx session link <task-or-session> --linear <KEY|URL> [--replace]` and `--unlink`, against a fake control plane: the route and body each
// form sends, a task id looked up for its session, the words printed, and the safety points (a refusal is printed as the server wrote it, safely; the key is checked before anything is sent).
import { afterEach, describe, expect, it } from "vitest";
import { agentsCli, cleanHarnessDirs, CELL } from "../support/agents-cli-harness.js";

afterEach(cleanHarnessDirs);

const SES = "ses_aaaaaaaaaaaaaaaaaaaa";
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const view = (bindings: Array<{ kind: string; url: string }>) => ({
  session: { sessionId: SES, kind: "task", title: "Fix the login bug", project: "payments", owner: { developerId: "d".repeat(64), name: "Priya" }, status: "running", step: "Writing the change", link: `${CELL}/s/${SES}`, bindings },
});
const refusal = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

describe("agentx session link", () => {
  it("links a session to an issue by key", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: Response.json(view([{ kind: "linear_issue", url: "https://linear.app/issue/ENG-142" }])) });
    expect(await h.run(["session", "link", SES, "--linear", "ENG-142"])).toBe(0);
    expect(h.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/bindings`, query: "", body: { linear: "ENG-142" } }]);
    expect(h.stdout()).toContain("Linked");
    expect(h.stdout()).toContain("ENG-142");
    expect(h.stdout()).toContain(`${CELL}/s/${SES}`);
  });

  it("sends the issue's Linear link as it was typed, and --replace as replace: true", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: Response.json(view([{ kind: "linear_issue", url: "https://linear.app/acme/issue/ENG-143" }])) });
    expect(await h.run(["session", "link", SES, "--linear", "https://linear.app/acme/issue/ENG-143/fix-it", "--replace"])).toBe(0);
    expect(h.calls[0]?.body).toEqual({ linear: "https://linear.app/acme/issue/ENG-143/fix-it", replace: true });
  });

  it("looks up a task's session when it is given a task id", async () => {
    const h = await agentsCli({
      [`GET /v1/dev/tasks/${TASK}`]: Response.json({ task: { taskId: TASK, sessionId: SES } }),
      [`POST /v1/app/sessions/${SES}/bindings`]: Response.json(view([{ kind: "linear_issue", url: "https://linear.app/issue/ENG-142" }])),
    });
    expect(await h.run(["session", "link", TASK, "--linear", "ENG-142"])).toBe(0);
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /v1/dev/tasks/${TASK}`, `POST /v1/app/sessions/${SES}/bindings`]);
  });

  it("says so when the task has no session, and sends nothing to link", async () => {
    const h = await agentsCli({ [`GET /v1/dev/tasks/${TASK}`]: Response.json({ task: { taskId: TASK } }) });
    expect(await h.run(["session", "link", TASK, "--linear", "ENG-142"])).not.toBe(0);
    expect(h.stderr()).toContain("no session");
    expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("promises the Fixes line only where the server says the description will carry it, and prints the server's note", async () => {
    const answers: Array<[string, Record<string, unknown>, RegExp | undefined, RegExp | undefined]> = [
      ["updated", { description: "updated" }, /Fixes ENG-142/u, undefined],
      ["next_update", { description: "next_update" }, /Fixes ENG-142/u, undefined],
      ["not_for_version", { description: "not_for_version", note: "This is an older Rovara Code task, so its pull request won't say Fixes ENG-142; write it there yourself." }, undefined, /Fixes ENG-142/u],
      ["failed", { description: "failed", note: "Rovara couldn't update the open pull request's description. Edit it on GitHub." }, undefined, /Edit it on GitHub/u],
    ];
    for (const [name, pullRequest, promise, note] of answers) {
      const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: Response.json({ ...view([{ kind: "linear_issue", url: "https://linear.app/issue/ENG-142" }]), pullRequest }) });
      expect(await h.run(["session", "link", SES, "--linear", "ENG-142"]), name).toBe(0);
      if (promise !== undefined) expect(h.stdout(), name).toMatch(/will say Fixes ENG-142/u);
      else expect(h.stdout(), name).not.toMatch(/will say Fixes/u);
      if (note !== undefined) expect(h.stdout(), name).toMatch(note);
    }
  });

  it("prints a note about the description after an unlink too, made safe for a terminal", async () => {
    const h = await agentsCli({ [`DELETE /v1/app/sessions/${SES}/bindings/linear`]: Response.json({ ...view([]), pullRequest: { description: "failed", note: "It may still say Fixes ENG-123\u001b[2J: edit it on GitHub." } }) });
    expect(await h.run(["session", "link", SES, "--unlink"])).toBe(0);
    expect(h.stdout()).toContain("edit it on GitHub");
    expect(h.stdout()).not.toContain("\u001b");
  });

  it("unlinks with --unlink", async () => {
    const h = await agentsCli({ [`DELETE /v1/app/sessions/${SES}/bindings/linear`]: Response.json(view([])) });
    expect(await h.run(["session", "link", SES, "--unlink"])).toBe(0);
    expect(h.calls).toEqual([{ method: "DELETE", path: `/v1/app/sessions/${SES}/bindings/linear`, query: "", body: undefined }]);
    expect(h.stdout()).toContain("Unlinked");
  });

  it("needs exactly one of --linear and --unlink, a real session or task id, and a key or link, before it sends anything", async () => {
    for (const argv of [
      ["session", "link", SES],
      ["session", "link", SES, "--linear", "ENG-142", "--unlink"],
      ["session", "link", SES, "--unlink", "--replace"],
      ["session", "link", "not-a-session", "--linear", "ENG-142"],
      ["session", "link", "..", "--linear", "ENG-142"],
      ["session", "link", SES, "--linear", "ENG"],
      ["session", "link", SES, "--linear", "ENG-142 and OPS-1"],
      ["session", "link", SES, "--linear", "https://evil.example/acme/issue/ENG-142"],
      ["session", "link", SES, "--linear", ""],
    ]) {
      const h = await agentsCli({});
      expect(await h.run(argv), argv.join(" ")).not.toBe(0);
      expect(h.calls, argv.join(" ")).toEqual([]);
    }
  });

  it("prints a refusal as the server wrote it, made safe for a terminal", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: refusal("SESSION_LEVEL_REQUIRED", "You need \"can edit\" on this session to link it to a Linear issue. Ask Priya\u001b[2J to share it with you.", 403) });
    expect(await h.run(["session", "link", SES, "--linear", "ENG-142"])).not.toBe(0);
    expect(h.stderr()).toContain("can edit");
    expect(h.stderr()).not.toContain("\u001b");
    const taken = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: refusal("CONFIG_INVALID", "This issue already follows another session.", 400) });
    expect(await taken.run(["session", "link", SES, "--linear", "ENG-142"])).not.toBe(0);
    expect(taken.stderr()).toContain("already follows another session");
  });

  it("prints --json for a link", async () => {
    const h = await agentsCli({ [`POST /v1/app/sessions/${SES}/bindings`]: Response.json(view([{ kind: "linear_issue", url: "https://linear.app/issue/ENG-142" }])) });
    expect(await h.run(["--json", "session", "link", SES, "--linear", "ENG-142"])).toBe(0);
    expect(JSON.parse(h.out.at(-1)!)).toMatchObject({ ok: true, data: { session: { sessionId: SES } } });
  });
});
