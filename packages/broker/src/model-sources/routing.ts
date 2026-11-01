// Company AI sources (Plan 3 Task 26): which source serves a step's model. The project's source order (else the org's) is walked, and the first source
// that serves the model, matched by `canonicalModelName`, is the route: the proxy alias the key may call, the API it speaks and the catalog entry whose
// limits and usage the run reports. A source is skipped, never guessed at, when it cannot be shown to be usable now: a kind or transport that is not at
// launch, a Bedrock source that has not passed its probe, an endpoint whose host is not approved in that source's own egress entry, a source that has
// been removed. A record that cannot be read refuses with a retryable error; it never falls back to Rovara's AI.
import {
  agentXError,
  canonicalModelName,
  modelCompany,
  sourceAlias,
  sourceKindProblem,
  type InvocationModelRoute,
  type ModelIdentifier,
  type ModelSource,
  type OrgId,
  type SourceLaunch,
} from "@agentx/contracts";
import { bedrockClaudeModelIds, proxyGeographyOfModelId, type ProxyGeography } from "@agentx/model-runtime/catalog";
import { chatGptConnectionUsable } from "../chatgpt/task-model.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import { readEgressDomains } from "../org/egress-domains.js";
import type { StoredModelSources } from "./store.js";

export type ModelRouteApi = InvocationModelRoute["api"];

/** Where a model is served from. A route that needs no alias (a ChatGPT plan, or an install with no model proxy) has neither alias nor api. */
export interface ModelRoute {
  sourceId: string;
  alias?: string;
  api?: ModelRouteApi;
  /** The catalog entry the model is known by, for its limits and the usage it reports. */
  catalog: string;
}

/** Whether a person's ChatGPT plan serves a model, and under which plan model id. */
export interface ChatGptServing {
  serves(developerId: string, model: ModelIdentifier): Promise<string | undefined>;
}

export interface RoutingDependencies {
  /** The org's sources. Absent on an install with no model proxy: the model then passes through unchanged. */
  sources?: { read(orgId: OrgId): Promise<StoredModelSources> };
  /** The project's own source order (Task 28), when it has one. */
  projectSourceOrder?: (orgId: OrgId, project: string) => Promise<readonly string[] | undefined>;
  /** For `personal-chatgpt`. Absent: no plan serves anything. */
  chatgpt?: ChatGptServing;
  /** Where an endpoint source's egress item is read. Absent: no endpoint can be shown to be approved. */
  egress?: Parameters<typeof readEgressDomains>[0];
  /** Which kinds and transports are on. Default: the shipped launch lists (nothing yet). */
  launch?: SourceLaunch;
  /** The Bedrock inference-profile geography the proxy serves when a model names none. Default `us`. */
  rovaraGeography?: ProxyGeography;
}

export interface RouteInput {
  orgId: OrgId;
  project: string;
  /** Whose ChatGPT plan may serve; absent for work no person's plan is asked to run. */
  payerDeveloperId?: string | undefined;
  model: ModelIdentifier;
  /** Who is asking, for the refusal's words: the agent's name and the step's. */
  subject?: { agent: string; step: string } | undefined;
}

/** The refusal when no source serves a step's model: the plan's exact words for MODEL_NOT_ALLOWED. */
export function modelNotAllowedText(subject: { agent: string; step: string }, model: ModelIdentifier, project: string): string {
  return `${subject.agent}'s ${subject.step} step uses ${model.provider}/${model.modelId}, which isn't allowed on ${project}. Ask the agent's owner to pick another model.`;
}

const unavailable = (error: unknown) => {
  // The error's name only: its words could hold an id or a host.
  console.log(JSON.stringify({ component: "broker", event: "model_routing.unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
  return agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy could not choose a source for this model");
};

type Source = StoredModelSources["sources"][number];

/** The API a source's models are called through. Claude on Bedrock goes through the Messages route the proxy verified; every other Bedrock model through completions. */
function apiOf(source: Source, entry: Source["models"][number]): ModelRouteApi {
  switch (source.kind) {
    case "anthropic": return "anthropic-messages";
    case "openai": return "openai-responses";
    case "openrouter": return "openai-completions";
    case "bedrock": return modelCompany(entry.catalog) === "anthropic" ? "anthropic-messages" : "openai-completions";
    case "endpoint": return source.api as ModelRouteApi;
  }
}

/** The alias Rovara's own catalog serves a model under (the catalog id), or undefined when the catalog does not hold the model. */
function rovaraAlias(model: ModelIdentifier, geography: ProxyGeography): string | undefined {
  const named = model.provider === "amazon-bedrock" ? proxyGeographyOfModelId(model.modelId) : undefined;
  const ids = bedrockClaudeModelIds(named ?? geography);
  if (model.provider === "amazon-bedrock" && ids.includes(model.modelId)) return model.modelId;
  const wanted = canonicalModelName(model);
  return ids.find((id) => canonicalModelName({ provider: "amazon-bedrock", modelId: id }) === wanted);
}

interface Walk { stored: StoredModelSources; ids: string[] }

async function walkOf(deps: RoutingDependencies & { sources: NonNullable<RoutingDependencies["sources"]> }, orgId: OrgId, project: string | undefined): Promise<Walk> {
  let stored: StoredModelSources;
  let chosen: readonly string[] | undefined;
  try {
    stored = await deps.sources.read(orgId);
    chosen = project === undefined || deps.projectSourceOrder === undefined ? undefined : await deps.projectSourceOrder(orgId, project);
  } catch (error) {
    throw unavailable(error);
  }
  // The org's order is the ceiling: a project may reorder or leave out, never add a source the org has taken out of its order (or removed).
  const ids = [...new Set(chosen ?? stored.order)].filter((id) => stored.order.includes(id));
  return { stored, ids };
}

/** The org's record and the source ids a project walks, in order (its own order, else the org's, within the org's). Unreadable is the retryable refusal. */
export async function effectiveSources(deps: RoutingDependencies, orgId: OrgId, project: string): Promise<{ stored: StoredModelSources; order: string[] } | undefined> {
  if (deps.sources === undefined) return undefined;
  const { stored, ids } = await walkOf({ ...deps, sources: deps.sources }, orgId, project);
  return { stored, order: ids };
}

/** Whether an endpoint's host is approved in that source's own egress entry (an approval for another source or another host is not this one's). */
async function hostApproved(deps: RoutingDependencies, orgId: OrgId, source: Source): Promise<boolean> {
  if (source.kind !== "endpoint" || deps.egress === undefined) return false;
  try {
    const item = await readEgressDomains(deps.egress, orgId, { kind: "model-source", sourceId: source.sourceId });
    const host = new URL(source.baseUrl).hostname;
    return item?.active === true && item.domains.some((entry) => entry.domain === host && entry.status === "approved");
  } catch (error) {
    throw unavailable(error);
  }
}

/** Whether a company source may be routed to at all: its kind and transport are at launch, a Bedrock source has passed its probe, an endpoint's host is approved. */
async function usable(deps: RoutingDependencies, walk: Walk, orgId: OrgId, source: Source): Promise<boolean> {
  if (walk.stored.removing.some((entry) => entry.sourceId === source.sourceId)) return false;
  if (sourceKindProblem(source.kind, source.kind === "endpoint" ? source.api : undefined, deps.launch) !== undefined) return false;
  if (source.kind === "bedrock" && !source.tested) return false;
  if (source.kind === "endpoint") return hostApproved(deps, orgId, source);
  return true;
}

/**
 * Every route that serves the model, in the order the sources are tried; the first is the one used. Empty when none does. On an install with no
 * model proxy the model passes through unchanged as Rovara's own.
 */
export async function servingRoutes(deps: RoutingDependencies, input: RouteInput): Promise<ModelRoute[]> {
  if (deps.sources === undefined) return [{ sourceId: "rovara", catalog: input.model.modelId }];
  const walk = await walkOf({ ...deps, sources: deps.sources }, input.orgId, input.project);
  const wanted = canonicalModelName(input.model);
  const routes: ModelRoute[] = [];
  for (const id of walk.ids) {
    if (id === "rovara") {
      const alias = rovaraAlias(input.model, deps.rovaraGeography ?? "us");
      if (alias !== undefined) routes.push({ sourceId: "rovara", alias, api: "anthropic-messages", catalog: alias });
    } else if (id === "personal-chatgpt") {
      const planModel = input.payerDeveloperId === undefined || deps.chatgpt === undefined ? undefined : await deps.chatgpt.serves(input.payerDeveloperId, input.model);
      if (planModel !== undefined) routes.push({ sourceId: id, catalog: planModel });
    } else {
      const source = walk.stored.sources.find((candidate) => candidate.sourceId === id);
      const entry = source?.models.find((candidate) => canonicalModelName(candidate.catalog) === wanted);
      if (source === undefined || entry === undefined || !(await usable(deps, walk, input.orgId, source))) continue;
      routes.push({ sourceId: id, alias: sourceAlias(input.orgId, id, entry.catalog), api: apiOf(source, entry), catalog: entry.catalog.modelId });
    }
  }
  return routes;
}

/** The route for a model: the first source that serves it, or MODEL_NOT_ALLOWED. */
export async function routeModel(deps: RoutingDependencies, input: RouteInput): Promise<ModelRoute> {
  const [route] = await servingRoutes(deps, input);
  if (route !== undefined) return route;
  const label = `${input.model.provider}/${input.model.modelId}`;
  throw agentXError("MODEL_NOT_ALLOWED", input.subject === undefined
    ? `${label} isn't served by any AI source your company can use on ${input.project}.`
    : modelNotAllowedText(input.subject, input.model, input.project));
}

/**
 * The models the org's sources can serve, for validating a recipe at publish: Rovara's catalog when Rovara is in the order, and the models of each
 * company source that is usable, in the order the sources are tried (the project's, when `project` is given, else the org's). A person's ChatGPT plan is not listed: whether it serves
 * a model depends on who is paying.
 */
export async function servableModels(deps: RoutingDependencies, orgId: OrgId, project?: string): Promise<ModelIdentifier[]> {
  const rovara = (): ModelIdentifier[] => bedrockClaudeModelIds(deps.rovaraGeography ?? "us").map((modelId) => ({ provider: "amazon-bedrock", modelId }));
  if (deps.sources === undefined) return rovara();
  // With a project: the sources in the order that project walks them (its own order, within the org's), which is the order a model is routed in.
  const walk = await walkOf({ ...deps, sources: deps.sources }, orgId, project);
  const listed = new Map<string, ModelIdentifier>();
  const add = (model: ModelIdentifier) => { listed.set(`${model.provider}\0${model.modelId}`, { provider: model.provider, modelId: model.modelId }); };
  for (const id of walk.ids) {
    if (id === "rovara") rovara().forEach(add);
    else if (id !== "personal-chatgpt") {
      const source = walk.stored.sources.find((candidate) => candidate.sourceId === id);
      if (source !== undefined && await usable(deps, walk, orgId, source)) source.models.forEach((entry) => { add(entry.catalog); });
    }
  }
  return [...listed.values()];
}

/**
 * What goes in an invocation's `modelRoute`: only a route the worker cannot reach by the model's own name. Rovara's catalog model asked for by its Bedrock
 * id is the worker's default path (the payload does not change), and a ChatGPT plan has its own field.
 */
export function routeOnWire(route: ModelRoute, model: ModelIdentifier): InvocationModelRoute | undefined {
  if (route.alias === undefined || route.api === undefined) return undefined;
  if (route.sourceId === "rovara" && model.provider === "amazon-bedrock" && model.modelId === route.alias) return undefined;
  return { alias: route.alias, api: route.api, catalog: route.catalog };
}

/** The ChatGPT side of routing, from the install's connections: the install switch, a working connection and the plan's allowed models. */
export function chatGptServing(connections: Pick<ChatGptConnections, "settings" | "view">, now: () => number = Date.now): ChatGptServing {
  return {
    async serves(developerId, model) {
      // OpenAI models that Bedrock serves are OpenAI's by company but are reached through Bedrock, never through a person's ChatGPT plan.
      if (model.provider === "amazon-bedrock" || modelCompany(model) !== "openai") return undefined;
      try {
        if (!(await connections.settings()).enabled) return undefined;
        const view = await connections.view(developerId);
        if (!chatGptConnectionUsable(view, now())) return undefined;
        const wanted = canonicalModelName(model);
        return (view.models ?? []).find((modelId) => canonicalModelName({ provider: "openai", modelId }) === wanted);
      } catch (error) {
        // A task never fails because its owner's connection could not be read: the plan serves nothing.
        console.log(JSON.stringify({ component: "broker", event: "chatgpt.connection_unreadable", errorName: error instanceof Error ? error.name : "unknown" }));
        return undefined;
      }
    },
  };
}

export type { ModelSource };
