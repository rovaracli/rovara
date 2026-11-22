import { SessionResponseReaderSchema } from "@agentx/contracts/web";

type ReadSession = ReturnType<typeof SessionResponseReaderSchema.parse>["session"];

/** Shared by the board capture and its mounted regression tests; synthetic read data only. */
export function taskBoardSessionFixture(base: ReadSession, state: string): ReadSession {
 if (base.body.kind !== "task") throw new Error("A task fixture is required");
 const task = base.body.task;
 let session = base;
 // Acceptance has no reported next phase; retaining the base approval workflow would invent one.
 if (state.startsWith("starting") || state === "talk-open-arrival") session = { ...base, status: "starting", step: "Preparing", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", body: { kind: "task", task: { ...task, status: "STARTING", workflow: undefined } } };
 if (state === "continuation-closed") session = { ...base, status: "stopped", step: "Closed", body: { kind: "task", task: { ...task, status: "CLOSED", workflow: { ...task.workflow!, stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" } } } };
 // These scenes record a budget/test-cap pause, with no recorded step or approval decision.
 if (state.startsWith("budget-")) session = { ...base, status: "paused", step: undefined, body: { kind: "task", task: { ...task, status: "INTERRUPTED", workflow: undefined } } };
 if (["budget-pause", "budget-unavailable-lost-freshness", "budget-partial-facts-no-authorized-destination"].includes(state)) session = { ...session, cost: { ...base.cost, paused: { scope: "Project budget" } } };
 if (state.startsWith("budget-test-cap")) session = { ...session, ...(state === "budget-test-cap-readonly" ? { you: { ...base.you, owner: false, level: "view", actions: ["watch"] } } : {}), body: { kind: "task", task: { ...task, status: "INTERRUPTED", workflow: undefined, testOffer: { capUsd: 1 } } } };
 return SessionResponseReaderSchema.parse({ session }).session;
}
