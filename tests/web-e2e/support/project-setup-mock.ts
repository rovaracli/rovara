// The routes the rich project setup reads and writes, for the `onboarding` scenario, once a journey asks (POST /__mock/project-setup { checks: ["failed", "ready"], agent?: true }): three repositories, the create route for
// a meta project, a setup check that answers from the list in order (the last answer repeats), the project overview, the setup agent (off unless asked), the test environment (off) and the start route. Not asked, nothing
// here answers, so the existing onboarding journeys see the cell exactly as before. The ask belongs to one scenario object: the next /__mock/scenario starts clean.
import { AppProjectDetailSchema, CloudProjectCreatedResponseSchema, CreateProjectFromMetaBodySchema, GithubRepositoriesResponseSchema } from "@agentx/contracts/web";
import { projectFixture } from "../../web/support/project-fixture.js";
import { taskFixture } from "../../web/support/session-fixture.js";
import { mockCellOrigin } from "./port.js";
import type { MockExchange } from "./how-we-work-mock.js";
type Project = ReturnType<typeof AppProjectDetailSchema.parse>;
type Check = "ready" | "failed";
export const PROJECT_SETUP_SESSION = "ses_cccccccccccccccccccc";
export const PROJECT_SETUP_FAILURE = "setup: pnpm install - The build of acme/checkout-ios can't reach registry.example (403 Forbidden)";
let asked: { scenario: unknown; checks: Check[]; agent: boolean; refuseStart: boolean; given: number } | undefined;
const REPOSITORIES = GithubRepositoriesResponseSchema.parse({ repositories: ["checkout-api", "checkout-ios", "mobile-meta"].map((name, at) => ({ fullName: "acme/" + name, githubRepositoryId: 201 + at, private: true, defaultBranch: "main" })) });
const detail = (name: string, repositories: string[], description: string, setup: Project["setup"]): Project => AppProjectDetailSchema.parse({ name, description, status: "active", latestRevision: 1, repositories: repositories.map(fullName => ({ fullName, defaultBranch: "main" })), myRole: "maintainer", setup, settings: { setupCommands: ["pnpm install"], testCommands: ["pnpm test"], devcontainer: null, allowedDomains: [] }, createdAt: "2026-11-01T12:00:00.000Z", createdBy: { developerId: "d".repeat(64), name: "Maya" } });
export async function projectSetupMock({ url, method, body, json, record, scenario }: MockExchange & { scenario: unknown }, project: { get(): Project | undefined; set(value: Project | undefined): void }): Promise<boolean> {
 if (url.pathname === "/__mock/project-setup" && method === "POST") {
  const input = await body() as { checks?: unknown; agent?: unknown; refuseStart?: unknown; seed?: unknown };
  asked = { scenario, checks: Array.isArray(input.checks) ? input.checks.map(item => item === "ready" ? "ready" : "failed") : ["ready"], agent: input.agent === true, refuseStart: input.refuseStart === true, given: 0 };
  // `seed`: a project that already exists (its setup as given), for a journey that starts at the environment check.
  if (input.seed === "failed" || input.seed === "unchecked" || input.seed === "ready") project.set(detail("mobile-checkout", ["acme/checkout-api", "acme/checkout-ios"], "Make paying in the mobile app fast and reliable.", input.seed === "failed" ? { status: "failed", failedStep: PROJECT_SETUP_FAILURE } : { status: input.seed }));
  json(200, { ok: true });return true;
 }
 if (asked === undefined || asked.scenario !== scenario) return false;
 if (url.pathname === "/v1/web/github/repositories" && method === "GET") { json(200, REPOSITORIES);return true; }
 if (url.pathname === "/v1/web/projects" && method === "POST") {
  const input = CreateProjectFromMetaBodySchema.parse(await body());record(input);
  const name = input.name ?? "mobile-checkout", repositories = input.codeRepositories ?? [input.metaRepository];
  project.set(detail(name, repositories, input.description ?? "", { status: "unchecked" }));
  json(201, CloudProjectCreatedResponseSchema.parse({ duplicate: false, project: { definition: { name }, registeredAt: "2026-11-01T12:00:00.000Z" } }));return true;
 }
 const current = project.get(), base = current === undefined ? undefined : "/v1/web/projects/" + current.name;
 if (current === undefined || base === undefined || !url.pathname.startsWith(base + "/")) return false;
 const rest = url.pathname.slice(base.length);
 if (rest === "/setup-check" && method === "POST") {
  const next = asked.checks[Math.min(asked.given, asked.checks.length - 1)]!;asked.given += 1;
  project.set(AppProjectDetailSchema.parse({ ...current, setup: next === "ready" ? { status: "ready", checkedRevision: current.latestRevision } : { status: "failed", failedStep: PROJECT_SETUP_FAILURE } }));
  json(202, { project: project.get() });return true;
 }
 if (rest === "/setup-agent" && method === "GET") { if (!asked.agent) { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return true; }json(200, { status: "none", basedOnRevision: current.latestRevision, limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 } });return true; }
 if (rest === "/test-environment" && method === "GET") { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return true; }
 if (rest === "/overview" && method === "GET") { const fixture = projectFixture();json(200, { ...fixture, project: { ...fixture.project, name: current.name }, you: { ...fixture.you, canStartWork: true } });return true; }
 if (rest === "/start-preview" && method === "POST") { json(404, { error: { code: "NOT_FOUND", message: "Not found." } });return true; }
 if (rest === "/code" && method === "POST") {
  record(await body());
  if (asked.refuseStart) { json(409, { error: { code: "SETUP_NOT_READY", message: "The setup check for this project has not passed." } });return true; }
  json(202, { task: taskFixture({ sessionId: PROJECT_SETUP_SESSION }), sessionId: PROJECT_SETUP_SESSION, sessionUrl: mockCellOrigin() + "/app/sessions/" + PROJECT_SETUP_SESSION });return true;
 }
 return false;
}
