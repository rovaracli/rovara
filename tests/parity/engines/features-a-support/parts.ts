// The parallel-parts feature (area 11), shared by both engines: a Full task whose coding plan has three parts, A and B independent and C on both
// (the same graph and edits as Cloud's own journey, tests/contract/rovara-code-parallel-parts-journey.test.ts).
import { planAnswer, planDocument } from "../../../support/plan-documents.js";

export const PART_A = "11111111-1111-4111-8111-111111111111";
export const PART_B = "22222222-2222-4222-8222-222222222222";
export const PART_C = "33333333-3333-4333-8333-333333333333";

export function partsGraph(taskId: string) {
  return { schemaVersion: 1 as const, taskId, version: 1, items: [
    { id: PART_A, title: "A: create formatter", description: "Create the shared formatter function.", repository: "demo", dependsOn: [] as string[] },
    { id: PART_B, title: "B: create clock", description: "Create the shared clock function.", repository: "demo", dependsOn: [] as string[] },
    { id: PART_C, title: "C: integration assertion", description: "Add an executable integration assertion over A and B.", repository: "demo", dependsOn: [PART_A, PART_B] },
  ] };
}

const CLAIMS = [{ id: "1", text: "Users can create and use a greeting service in src/greeting.ts, covered by a test in src/greeting.test.ts." }];

/** The planner's answer for one phase of a Full task: requirements and design are plain; the coding plan carries the parts. */
export function partsPlan(taskId: string, phase: "requirements" | "design" | "plan"): string {
  if (phase === "requirements") return planAnswer(planDocument({ title: "Requirements", claims: CLAIMS }));
  if (phase === "design") return planAnswer(planDocument({ title: "Design", claims: CLAIMS }));
  return planAnswer(planDocument({ title: "Coding plan", claims: CLAIMS, workBreakdown: partsGraph(taskId) }));
}

/** The files each part writes (relative to the repository). */
export const PART_FILES: Readonly<Record<string, Record<string, string>>> = {
  [PART_A]: { "formatter.mjs": "export const formatGreeting = (name) => `Hello, ${name}`;\n" },
  [PART_B]: { "clock.mjs": "export const today = () => '2026-10-26';\n" },
  [PART_C]: { "integration.mjs": "import assert from 'node:assert/strict';\nimport { formatGreeting } from './formatter.mjs';\nimport { today } from './clock.mjs';\nassert.equal(formatGreeting('Ada'), 'Hello, Ada');\nassert.equal(today(), '2026-10-26');\n" },
};

/** The part order both engines are expected to report: A and B start together, C only after both are built. */
export const PART_TITLES: Readonly<Record<string, string>> = { [PART_A]: "A", [PART_B]: "B", [PART_C]: "C" };
