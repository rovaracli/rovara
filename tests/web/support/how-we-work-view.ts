import { HOW_WE_WORK_REVIEWER_NOTE, HowWeWorkViewSchema } from "@agentx/cloud-contracts/web";
export const LAYER = "agt_cccccccccccccccccccc";
type Mark = { source: "rovara" | "company" | "project"; locked: boolean; lockedBy?: "company" | "rovara" };
const inherited: Mark = { source: "rovara", locked: false }, project: Mark = { source: "project", locked: false }, company: Mark = { source: "company", locked: true, lockedBy: "company" }, rovaraLock: Mark = { source: "rovara", locked: true, lockedBy: "rovara" };
const value = <T>(entry: T, mark: Mark = inherited) => ({ value: entry, ...mark });
/** One stage record as the broker sends it (counts only). */
export const record = (claim: string, held: number, notHeld: number, over: Record<string, unknown> = {}) => ({ claim, held, notHeld, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, windowDays: 30, capped: false, enough: true, ...over });
/** The records of the plan check, the review (code and security) and the tests. */
export const stageRecords: Record<string, unknown[]> = {
 plan_critic: [record("plan_ready", 14, 3)],
 review: [record("review_pass:CRITIC", 9, 1, { closedUnmerged: 2, unreviewedMerges: 3 }), record("review_pass:SECURITY", 4, 2, { enough: false })],
 check: [record("proves_change", 14, 2)],
};
function stage(id: string, name: string, kind: string, parts: { model?: ReturnType<typeof value>; instructions?: ReturnType<typeof value>[]; note?: boolean; tools?: ReturnType<typeof value>; readOnly?: boolean; checked?: ReturnType<typeof value>[]; evidence?: ReturnType<typeof value>[]; approves?: ReturnType<typeof value>[]; different?: ReturnType<typeof value> } = {}) {
 return { id, name, kind, who: { model: parts.model ?? value(null), thinking: value(null), differentCompanyFrom: parts.different ?? value([]) }, knows: { instructions: parts.instructions ?? [], ...(parts.note ? { note: HOW_WE_WORK_REVIEWER_NOTE } : {}) }, may: { tools: parts.tools ?? value(null), readOnly: parts.readOnly ?? false }, checked: { items: parts.checked ?? [] }, evidence: { items: parts.evidence ?? [] }, approves: { items: parts.approves ?? [] } };
}
/** The view of a project that has published rules: a project-wide rule, a Build instruction, a company-locked review, Rovara's own guidance on Plan, and quiet stages. */
export function howWeWorkView(overrides: Record<string, unknown> = {}) {
 return HowWeWorkViewSchema.parse({ project: "payments", playbookRevision: 1, process: { kind: "project_process", agentId: LAYER, version: 2, draftRevision: 3 }, modelsEditable: false,
  rules: [value("Keep changes small.", project)],
  stages: [
   stage("plan", "Plan", "plan", { instructions: [value("Rovara plan guidance", inherited), value("Keep changes small.", project)], tools: value(["read", "grep"], rovaraLock), readOnly: true }),
   stage("plan_critic", "Plan check", "plan_critic", { note: true, tools: value(["read"], rovaraLock), readOnly: true, different: value(["plan"], company) }),
   stage("build", "Build", "build", { model: value("anthropic/claude-sonnet-4-6", project), instructions: [value("Run the linter.", project)] }),
   stage("check", "Checks", "check", { checked: [value("npm test", inherited)], evidence: [value("Test output is kept", inherited)] }),
   stage("review", "Review", "review", { note: true, tools: value(["read"], rovaraLock), readOnly: true, approves: [value("A person reads the review", inherited)] }),
   stage("pull_request", "Pull request", "pull_request", { evidence: [value("The pull request link", inherited)] }),
  ], ...overrides });
}
export const draftBody = (overlay: Record<string, unknown>, revision: number) => ({ draft: { overlay, revision, updatedBy: "a".repeat(64), updatedAt: "2026-10-27T10:00:00.000Z" } });
export const diffBody = (from: unknown, changes: string[] = ["/instructions"], lessSafe: string[] = [], to: unknown = "draft") => ({ from, to, changes, lessSafe });
