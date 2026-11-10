// Lessons in the repo (0.5.13): `agentx project lessons-repo` prints the fixed "starts when lessons are switched on" line under a switched-on repository whose lessons are off, for the status and for the answer to `on`.
import { describe, expect, it, vi } from "vitest";
import { LESSON_FILE_WAITING_TEXT } from "@agentx/contracts";

const answers: { body: unknown } = { body: {} };
vi.mock("../../packages/cli/src/developer/agents.js", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  appRequest: async () => ({ env: "e", url: "https://x.example", status: 200, body: answers.body }),
}));
const { projectLessonsRepo } = await import("../../packages/cli/src/developer/lessons-repo.js");

const row = (over: Record<string, unknown> = {}) => ({ repo: "api", enabled: true, fileDeleted: false, unmerged: 0, additionsPaused: false, removalsWaiting: 0, held: 0, pointer: "added", notices: [], ...over });
const run = (action: string, options: { repo?: string } = {}) => projectLessonsRepo({} as never, undefined, "payments", action, options);

describe("agentx project lessons-repo, lessons off", () => {
  it("prints what each switched-on repository waits for in the status", async () => {
    answers.body = { lessonsOff: true, canEnable: true, repos: [row({ waitingFor: "install" }), row({ repo: "web", waitingFor: "project" })], available: [] };
    const text = (await run("status")).text;
    expect(text).toContain(`  api: on; no pull request open; 0 unmerged in a row\n    ${LESSON_FILE_WAITING_TEXT.install}`);
    expect(text).toContain(`  web: on; no pull request open; 0 unmerged in a row\n    ${LESSON_FILE_WAITING_TEXT.project}`);
    expect(LESSON_FILE_WAITING_TEXT.install).toBe("The lessons file starts when lessons are switched on for this installation.");
    expect(LESSON_FILE_WAITING_TEXT.project).toBe("The lessons file starts when lessons are switched on for this project.");
  });

  it("prints it in the answer to on, and prints nothing extra when lessons are on", async () => {
    answers.body = row({ waitingFor: "install" });
    expect((await run("on", { repo: "api" })).text).toContain(LESSON_FILE_WAITING_TEXT.install);
    answers.body = row();
    expect((await run("on", { repo: "api" })).text).not.toContain("starts when lessons");
  });
});
