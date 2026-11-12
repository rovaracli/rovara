import { AppNavSchema, webFeatureNames, type AppNav, type OrgRole, type OrgRecord } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { safeDisplayName } from "../developer/person-name.js";
import { scriptTokensEnabled } from "../script-tokens/switch.js";
import { standingInstructionsEnabled } from "../instructions/switch.js";
import { decisionCardsEnabled } from "../proof/switch.js";
export const APP_NAV_CACHE_MS = 5000;
const CACHE_ENTRIES_MAX = 256;
export interface NavCaller { orgId: OrgId; developerId: string; name: string; orgRole: OrgRole; /** True once the person chose their name (release 0.4.16); the web app asks once while it is false. */ nameChosen?: boolean }
interface NavAgent { agentId: string; name: string }
interface NavSession { sessionId: string; title: string; endedAt?: string }
interface LiveRow { sessionId: string; project?: string; agentId?: string; running: boolean; needsYou: boolean }
export interface AppNavSources {
 // RULING Q17: adapters must use the owning backend's caller-specific access checks and complete source reads, never an org-wide row list.
 projects(caller: NavCaller): Promise<Array<{ name: string }>>;
 rosters(caller: NavCaller, projects: string[]): Promise<Array<NavAgent & { project: string }>>;
 live(caller: NavCaller): Promise<LiveRow[]>;
 home(caller: NavCaller): Promise<{ total: number; needsYou?: number | undefined; /** How many of those same items are about each project (the caller's own); absent where the source does not say. */ byProject?: Readonly<Record<string, number>> | undefined }>;
 sharedAgents(caller: NavCaller): Promise<NavAgent[]>;
 sharedSessions(caller: NavCaller): Promise<NavSession[]>;
 org(caller: NavCaller): Promise<{ name: string; plan: "trial" | "team"; createdBy?: string; trialUnlockedAt?: number; trialGithubUsedAt?: number }>;
}
export interface AppNavDependencies { sources?: AppNavSources; now: () => number; webFeatures: string; localAgents: boolean; /** QA6-10: the release the deploy says it carries (AGENTX_RELEASE_VERSION); shown only when it is a plain release number. */ release?: string; /** Enterprise foundations E3: the edition has no trial, so the org carries no trial state. */ hideTrial?: true }
interface Cached { expiresAt: number; role: OrgRole; name: string; nameChosen: boolean | undefined; value: Promise<AppNav> }
const caches = new WeakMap<AppNavDependencies, Map<string, Cached>>();
export function orgTrial(org: Pick<OrgRecord, "plan"> & Partial<Pick<OrgRecord, "createdBy" | "trialUnlockedAt" | "trialGithubUsedAt">>): AppNav["org"]["trial"] {
 if (org.plan !== "trial" || org.createdBy === "system") return undefined;
 return { state: org.trialUnlockedAt !== undefined ? "unlocked" : org.trialGithubUsedAt !== undefined ? "github_used" : "locked" };
}
export function appNav(deps: AppNavDependencies, caller: NavCaller): Promise<AppNav> {
 if (deps.sources === undefined) return Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "Navigation is temporarily unavailable. Try again shortly."));
 let cache = caches.get(deps);if (cache === undefined) { cache = new Map();caches.set(deps, cache); }
 const key = caller.orgId + "#" + caller.developerId, previous = cache.get(key);
 if (previous !== undefined && previous.expiresAt > deps.now() && previous.role === caller.orgRole && previous.name === caller.name && previous.nameChosen === caller.nameChosen) return previous.value;
 const sources = deps.sources;
 const value = (async () => {
 const [projects, live, home, sharedAgents, sharedSessions, org] = await Promise.all([sources.projects(caller), sources.live(caller), sources.home(caller), sources.sharedAgents(caller), sources.sharedSessions(caller), sources.org(caller)]);
 const names = [...new Set(projects.map(project => project.name))].sort().slice(0, 50);
 const rosters = await sources.rosters(caller, names);
 const features = new Set(webFeatureNames(deps.webFeatures));
 return AppNavSchema.parse({
 me: { developerId: caller.developerId, name: safeDisplayName(caller.name, caller.developerId), orgRole: caller.orgRole, ...(caller.nameChosen === undefined ? {} : { nameChosen: caller.nameChosen }) },
 org: { name: org.name, ...(deps.hideTrial === true || orgTrial(org) === undefined ? {} : { trial: orgTrial(org) }) },
 // UX2 slice 2: the ONE "needs you" count, the same number Home shows (its cards plus pending decision cards).
 homeCount: home.needsYou ?? home.total,
 projects: names.map(name => ({ name, ...(home.byProject === undefined ? {} : { needsYou: Object.hasOwn(home.byProject, name) ? home.byProject[name]! : 0 }), agents: rosters.filter(agent => agent.project === name).map(agent => ({ agentId: agent.agentId, name: agent.name, running: live.filter(session => session.project === name && session.agentId === agent.agentId && session.running).length, needsYou: live.filter(session => session.project === name && session.agentId === agent.agentId && session.needsYou).length })) })),
 shared: { agents: sharedAgents.slice(0, 20).map(agent => ({ agentId: agent.agentId, name: agent.name })), sessions: sharedSessions.filter(session => session.endedAt === undefined).slice(0, 10).map(session => ({ sessionId: session.sessionId, title: session.title })) },
 ...(deps.release !== undefined && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(deps.release) ? { release: deps.release } : {}),
 features: { localAgents: deps.localAgents, usage: features.has("usage"), admin: features.has("admin") && (caller.orgRole === "owner" || caller.orgRole === "admin"), chains: features.has("chains"), notices: features.has("notices"), describe: features.has("describe"), ...(scriptTokensEnabled() ? { scriptTokens: true as const } : {}), ...(decisionCardsEnabled() ? { decisionCards: true as const } : {}), ...(standingInstructionsEnabled() ? { companyRules: true as const } : {}) },
 });
 })();
 const entry = { value, role: caller.orgRole, name: caller.name, nameChosen: caller.nameChosen, expiresAt: deps.now() + APP_NAV_CACHE_MS };
 cache.delete(key);cache.set(key, entry);
 if (cache.size > CACHE_ENTRIES_MAX) { const first = cache.keys().next().value;if (first !== undefined) cache.delete(first); }
 void value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
 return value;
}
