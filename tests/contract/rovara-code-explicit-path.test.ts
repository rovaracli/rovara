// Rovara Code (playbook round 2, R1a): the pure guard that decides whether Understand's `answer` ends the task or is planned instead. The broker's use of it is covered in
// rovara-code-understand.test.ts and rovara-code-answered.test.ts.
import { describe, expect, it } from "vitest";
import type { IntentAssessment, WorkflowIntent } from "@agentx/contracts";
import { assessmentForTask, explicitPathAssumption, isExplicitPath } from "../../packages/broker/src/rovara-code/explicit-path.js";

const answer: IntentAssessment = { kind: "answer", restatement: "What does the retry flag do?", answer: "It turns retries on.", sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }] };
const ready: IntentAssessment = { kind: "ready", path: "FULL", restatement: "Change it.", assumptions: ["One."] };
const questions: IntentAssessment = { kind: "questions", restatement: "Change it.", questions: [{ id: "q1", text: "Which one?" }] };
const workflow = (pathFrom: WorkflowIntent["pathFrom"] | undefined, path: "QUICK" | "FULL" = "QUICK") => ({ path, ...(pathFrom === undefined ? {} : { intent: { rounds: 0, pathFrom, answers: [] } }) });

describe("an explicit path wins over an Understand answer", () => {
  it("plans the change on the chosen path, with fixed words that name only the path", () => {
    expect(assessmentForTask({ assessment: answer, workflow: workflow("request", "QUICK"), followsAnswer: false })).toEqual({
      kind: "ready", path: "QUICK", restatement: answer.restatement, assumptions: ["You chose Quick, so I planned the change instead of answering."],
    });
    expect(assessmentForTask({ assessment: answer, workflow: workflow("request", "FULL"), followsAnswer: false })).toMatchObject({
      kind: "ready", path: "FULL", assumptions: ["You chose Full, so I planned the change instead of answering."],
    });
    expect(explicitPathAssumption("QUICK")).not.toContain(answer.answer);
  });

  it("leaves an answer alone when Understand chose the path, when the hand-off set it, and when the workflow has no intent", () => {
    for (const pathFrom of ["understand", "handoff", undefined] as const) {
      expect(assessmentForTask({ assessment: answer, workflow: workflow(pathFrom), followsAnswer: false }), String(pathFrom)).toBe(answer);
      expect(isExplicitPath(workflow(pathFrom)), String(pathFrom)).toBe(false);
    }
    expect(isExplicitPath(workflow("request"))).toBe(true);
  });

  it("a task that follows an answered one still converts, with its own words, whoever chose the path", () => {
    for (const pathFrom of ["understand", "request"] as const) {
      expect(assessmentForTask({ assessment: answer, workflow: workflow(pathFrom), followsAnswer: true }), pathFrom).toMatchObject({
        kind: "ready", assumptions: ["An earlier answer said no change was needed; you asked for the change anyway."],
      });
    }
  });

  it("returns ready and questions untouched, for every path source", () => {
    for (const pathFrom of ["request", "understand", "handoff", undefined] as const) {
      for (const followsAnswer of [false, true]) {
        expect(assessmentForTask({ assessment: ready, workflow: workflow(pathFrom), followsAnswer })).toBe(ready);
        expect(assessmentForTask({ assessment: questions, workflow: workflow(pathFrom), followsAnswer })).toBe(questions);
      }
    }
  });
});
