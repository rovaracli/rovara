// Lessons in the repo (owner decision 78): `agentx project lessons-repo` answers for lessons that went missing from the file (`retire-confirm`, `retire-keep`), always with the digest the status showed, and the status says how.
import { describe, expect, it, vi } from "vitest";

const seen: { path?: string; options?: { method?: string; body?: unknown } | undefined } = {};
const answers: { body: unknown } = { body: {} };
vi.mock("../../packages/cli/src/developer/agents.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  appRequest: async (_deps: unknown, _env: unknown, path: string, options?: { method?: string; body?: unknown }) => { seen.path = path; seen.options = options; return { env: "e", url: "https://x.example", status: 200, body: answers.body }; },
}));
const { projectLessonsRepo } = await import("../../packages/cli/src/developer/lessons-repo.js");

const DIGEST = "0123456789abcdef";
const row = (over: Record<string, unknown> = {}) => ({ repo: "api", enabled: true, fileDeleted: false, unmerged: 0, additionsPaused: false, removalsWaiting: 0, held: 0, pointer: "added", notices: [], ...over });
const run = (action: string, options: { repo?: string; held?: string } = {}) => projectLessonsRepo({} as never, undefined, "payments", action, options);

describe("agentx project lessons-repo retire-confirm and retire-keep", () => {
  it("send the action with the digest, and refuse a missing or malformed digest, or a digest on another action, before asking the server", async () => {
    answers.body = row();
    await run("retire-confirm", { repo: "api", held: DIGEST });
    expect(seen.options).toMatchObject({ method: "POST", body: { action: "retire_confirm", repo: "api", held: DIGEST } });
    await run("retire-keep", { repo: "api", held: DIGEST });
    expect(seen.options).toMatchObject({ body: { action: "retire_keep", repo: "api", held: DIGEST } });
    seen.options = undefined;
    await expect(run("retire-keep", { repo: "api" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(run("retire-keep", { repo: "api", held: "nope" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(run("off", { repo: "api", held: DIGEST })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(seen.options).toBeUndefined();
  });

  it("the status prints the fixed sentence and the command to answer it, with the digest", async () => {
    answers.body = { lessonsOff: false, canEnable: true, available: [], repos: [row({ retireConfirm: { missing: 7, since: 1, digest: DIGEST }, notices: ["7 lessons have been missing from the lessons file since 2026-11-01. Confirm to retire them, or keep them"] })] };
    const text = (await run("status")).text;
    expect(text).toContain("7 lessons have been missing from the lessons file since 2026-11-01. Confirm to retire them, or keep them");
    expect(text).toContain(`agentx project lessons-repo payments retire-confirm (or retire-keep) --repo api --held ${DIGEST}`);
  });
});
