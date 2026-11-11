// Decision 46b: `agentx lessons local [status|on|off] --project <name>` reads and sets the project's switch through the lessons route and prints fixed sentences. The company's switch is shown in the status; an owner or admin changes it in the app.
import { describe, expect, it, vi } from "vitest";

const answers: { body: unknown; calls: Array<{ path: string; method?: string; body?: unknown }> } = { body: {}, calls: [] };
vi.mock("../../packages/cli/src/developer/agents.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  appRequest: async (_deps: unknown, _env: unknown, path: string, options: { method?: string; body?: unknown } = {}) => { answers.calls.push({ path, ...options }); return { env: "e", url: "https://x.example", status: 200, body: answers.body }; },
}));
const { localToolsSetting } = await import("../../packages/cli/src/developer/lessons-local.js");
const run = (project: string | undefined, action?: string) => localToolsSetting({} as never, undefined, project, action);

describe("agentx lessons local", () => {
  it("prints what the project's switch comes to, and why not, in fixed sentences", async () => {
    answers.body = { enabled: true, preset: "standard", companyStays: false };
    const on = (await run("payments")).text;
    expect(on).toContain("Local coding tools for payments: on");
    expect(on).toContain("The project's own choice: not set (on under Standard, off under Regulated)");
    expect(answers.calls.at(-1)).toMatchObject({ path: "/v1/app/projects/payments/lessons/local-tools" });
    expect(answers.calls.at(-1)!.method).toBeUndefined();
    answers.body = { enabled: false, own: true, reason: "company_stays", preset: "standard", companyStays: true };
    const off = (await run("payments", "status")).text;
    expect(off).toContain("off (your company keeps lessons inside Rovara)");
    expect(off).toContain("The company keeps lessons inside Rovara: yes");
    answers.body = { enabled: false, own: true, reason: "regulated", preset: "regulated", companyStays: false };
    expect((await run("payments")).text).toContain("the project uses the Regulated preset");
  });

  it("on and off send the project's choice once, to the project's route", async () => {
    answers.body = { enabled: false, own: false, reason: "project_setting", preset: "standard", companyStays: false };
    const result = await run("payments", "off");
    expect(answers.calls.at(-1)).toMatchObject({ path: "/v1/app/projects/payments/lessons/local-tools", method: "POST", body: { enabled: false } });
    expect(result.text).toContain("off (the project switched it off)");
    await run("payments", "on");
    expect(answers.calls.at(-1)).toMatchObject({ method: "POST", body: { enabled: true } });
  });

  it("needs a project and a known action, and refuses an answer it does not understand", async () => {
    await expect(run(undefined)).rejects.toThrow(/--project/u);
    await expect(run("payments", "maybe")).rejects.toThrow(/status, on, off/u);
    answers.body = { nope: true };
    await expect(run("payments")).rejects.toThrow(/unexpected/u);
  });
});
