// The routes the Working agreement panel reads, as one cell: the project's How we work view, the design review setting, the lessons and learning settings, the known failing policy, the company rules count and the
// stage models. Each part can be changed, or left out (answered 404, the way an install without it answers).
import { CompanyRulesStateSchema, LearningViewAnswerSchema } from "@agentx/cloud-contracts/web";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
import { fakeHost } from "./fake-host.js";
import { navFixture } from "./fixtures.js";
import { howWeWorkView } from "./how-we-work-view.js";
import { view as lessonsView } from "./lessons-fixture.js";
import { effective, mid, stageEntry, stageModelsRaw, SONNET, OPUS } from "./stage-models-raw.js";
import { StageModelsResponseSchema } from "@agentx/cloud-contracts/web";

export type Part = "view" | "playbook" | "models" | "lessons" | "learning" | "policy" | "rules";
export interface AgreementWorld {
 /** Parts answered 404. */
 off?: readonly Part[];
 /** Parts answered with a refusal that is neither 403 nor 404. */
 broken?: readonly Part[];
 view?: unknown; playbook?: unknown; models?: unknown; lessons?: unknown; learning?: unknown; policy?: unknown; rules?: unknown;
 admin?: boolean;
 /** The nav answer's `features.companyRules` (default true). Off, it is absent from the answer, as on an install without the Standing instructions switch. */
 companyRulesFeature?: boolean;
}
export const NOT_FOUND: ApiResponse = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
export const playbook = (over: Record<string, unknown> = {}, setting: Record<string, unknown> = {}) => ({
 playbook: { revision: 4, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "standard", allowSkip: false, capUsdPerTask: 15, highRiskApprover: { kind: "maintainers" }, ...setting } },
 designReviewLocked: ["designReview.allowSkip"], designReviewGroups: false, designReviewAllowed: true, ...over,
});
export const learning = (settings: Record<string, unknown> = {}) => LearningViewAnswerSchema.parse({ settings: { prComments: "on", locked: false, ...settings }, suggestions: [], dismissed: [], rules: [], skippedUnlinked: 0, canDecide: true });
export const policy = (over: Record<string, unknown> = {}) => ({ alwaysTwoPeople: true, pendingLoosening: false, ...over });
/** The company rules answer as the contract's strict schema reads it (the admin route's state; the member route's `current` is the same shape without `viewer`, `pending` and `sync`, which the reader leaves unread). */
export const rules = (required: number, preferred: number, over: Record<string, unknown> = {}) => {
 const list = [...Array.from({ length: required }, () => ({ text: "Never log secrets.", priority: "required" })), ...Array.from({ length: preferred }, () => ({ text: "Prefer small pull requests.", priority: "preferred" }))];
 return CompanyRulesStateSchema.parse({ enabled: true, viewer: { role: "admin", canPropose: true, canDecide: true }, limits: { maxRules: 30, maxRuleCharacters: 600, maxTotalCharacters: 12_000 }, current: list.length === 0 ? null : { version: 3, digest: "c".repeat(64), rules: list, ruleCount: list.length, approvedAt: "2026-11-11T05:00:00.000Z" }, pending: null, sync: null, ...over });
};
export const models = () => StageModelsResponseSchema.parse(stageModelsRaw({
 build: stageEntry("build", { projectChoice: { model: mid(SONNET) }, effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_CHOICE" }) }),
 code_review: stageEntry("code_review", { locked: true, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }) }),
}));
const BODIES: Record<Part, (world: AgreementWorld) => unknown> = {
 view: world => world.view ?? howWeWorkView(),
 playbook: world => world.playbook ?? playbook(),
 models: world => world.models ?? models(),
 lessons: world => world.lessons ?? lessonsView({ preset: "regulated", presetLockedByCompany: true, mode: "Suggest" }),
 learning: world => world.learning ?? learning(),
 policy: world => world.policy ?? policy(),
 rules: world => world.rules ?? rules(2, 1),
};
const ROUTES: ReadonlyArray<[Part, (path: string) => boolean]> = [
 ["view", path => path === "/v1/app/projects/payments/how-we-work"],
 ["playbook", path => path === "/v1/app/projects/payments/playbook"],
 ["models", path => path === "/v1/app/projects/payments/stage-models"],
 ["lessons", path => path === "/v1/app/projects/payments/lessons"],
 ["learning", path => path === "/v1/app/projects/payments/learning"],
 ["policy", path => path === "/v1/app/org/known-failing-policy"],
 ["rules", path => path === "/v1/app/org/company-rules" || path === "/v1/app/org/company-rules/current"],
];
/** The body each part answers, for a mock cell that has its own routing. `undefined` where the part is left out. */
export function agreementBody(world: AgreementWorld, part: Part): { status: number; body: unknown } {
 if (world.off?.includes(part) === true) return NOT_FOUND;
 if (world.broken?.includes(part) === true) return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Broken." } } };
 return { status: 200, body: BODIES[part](world) };
}
/** The nav answer. `features.companyRules` is not in this base's strict nav schema (the company rules lane adds it), so it is added after the parse. */
export function agreementNav(world: AgreementWorld = {}) {
 const nav = navFixture({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: world.admin === false ? "member" : "admin" }, features: { localAgents: false, usage: true, admin: true, chains: false, notices: false, describe: false } });
 return { ...nav, features: { ...nav.features, ...(world.companyRulesFeature === false ? {} : { companyRules: true }) } };
}
export function agreementHost(world: AgreementWorld = {}) {
 const fake = fakeHost(async (request: ApiRequest) => {
  const path = request.path.split("?")[0]!;
  if (path === "/v1/app/nav") return { status: 200, body: agreementNav(world) };
  const route = ROUTES.find(([, matches]) => matches(path));
  if (route !== undefined) return agreementBody(world, route[0]);
  return NOT_FOUND;
 });
 return { ...fake, calls: () => fake.request.mock.calls.map(([request]) => request.method + " " + request.path) };
}
