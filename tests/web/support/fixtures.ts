import { AppMeResponseSchema, AppNavSchema, HomeResponseSchema, type AppMeResponse, type AppNav } from "@agentx/cloud-contracts/web";
export const FIXTURE_ORG = "org_aaaaaaaaaaaaaaaaaaaa", FIXTURE_DEVELOPER = "a".repeat(64), FIXTURE_SESSION = "11111111-1111-4111-8111-111111111111";
export function navFixture(overrides: Partial<AppNav> = {}): AppNav {
 return AppNavSchema.parse({ me: { developerId: FIXTURE_DEVELOPER, name: "Priya", orgRole: "member" }, org: { name: "Acme" }, homeCount: 3, projects: [{ name: "payments", agents: [{ agentId: "agt_aaaaaaaaaaaaaaaaaaaa", name: "Payments expert", running: 1, needsYou: 1 }] }], shared: { agents: [], sessions: [] }, features: { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false }, ...overrides });
}
const strictMe = AppMeResponseSchema.extend({ developer: AppMeResponseSchema.shape.developer.strict(), org: AppMeResponseSchema.shape.org.strict(), identities: AppMeResponseSchema.shape.identities.element.strict().array() }).strict();
export function meFixture(overrides: Partial<AppMeResponse> = {}): AppMeResponse { return strictMe.parse({ developer: { id: FIXTURE_DEVELOPER, name: "Priya", orgRole: "member" }, org: { orgId: FIXTURE_ORG, name: "Acme", plan: "team" }, identities: [], ...overrides }); }
export function homeFixture(overrides: Partial<ReturnType<typeof HomeResponseSchema.parse>> = {}) { return HomeResponseSchema.parse({ cards: [], total: overrides.cards?.length ?? 0, ...overrides }); }
