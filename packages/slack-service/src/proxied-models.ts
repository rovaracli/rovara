// Task 13 and ruling R32: the model access of Slack requests when the model proxy is on. One access source is made per incoming
// message (keyed by its event ID), so the router, the gate's classifier and the orchestrator's runtime of one message share a
// single key request however many of them it uses, and a redelivery of the message reuses the key until it nears its end.
import type { InvocationModelRoute, SlackRequestMessage } from "@rovara-code/contracts";
import type { RequestRouter } from "@agentx/orchestrator/request-router";
import type { ActionClassifier } from "@agentx/orchestrator/action-gate";
import { ClassifierError } from "@agentx/orchestrator/action-classifier";
import { turnModelAccessSource, turnModelProxy, turnModelRoute, type TurnModelAccess } from "./model-access.js";
import type { createHostedClassifier, createHostedRequestRouter } from "./runtime.js";
import type { ServiceLog } from "./processor.js";

/** The most messages whose access source is kept; the oldest is let go first. */
const REMEMBERED_MESSAGES = 256;

export interface ProxiedModelsOptions {
  controlPlaneUrl: string;
  /** Signs a request as the orchestrator role for this message's thread and member. */
  signedFetchFor: (message: SlackRequestMessage) => typeof fetch;
  classifierModel: { provider: string; modelId: string };
  /** The model the orchestrator answers with, told to the control plane so it can route it (Task 26). */
  orchestratorModel?: { provider: string; modelId: string };
  classifierTimeoutMs: number;
  log: ServiceLog;
  createClassifier: typeof createHostedClassifier;
  createRouter: typeof createHostedRequestRouter;
  now?: () => number;
  /** Live interaction A3: where this message's key is asked for, when it is not a Slack turn's (an Ask names its own route and body). */
  accessRouteFor?: (message: SlackRequestMessage) => { orgId: string; path: string; body: Readonly<Record<string, string | boolean>> } | undefined;
}

export interface ProxiedModels {
  /** The message's proxy; the key is requested once for the message and again only as it nears its end. */
  proxyFor(message: SlackRequestMessage): Promise<{ baseUrl: string; apiKey: () => Promise<string> }>;
  /** The proxy and the gate's classifier for the message's turn. */
  turnModels(message: SlackRequestMessage): Promise<{ proxy: { baseUrl: string; apiKey: () => Promise<string> }; classifier: ActionClassifier; route?: InvocationModelRoute }>;
  /** The router for the message: made on first use, and unavailable (never a throw) when no key can be had. */
  routerFor(message: SlackRequestMessage): RequestRouter;
}

export function createProxiedModels(options: ProxiedModelsOptions): ProxiedModels {
  const sources = new Map<string, () => Promise<TurnModelAccess>>();
  const sourceFor = (message: SlackRequestMessage) => {
    let source = sources.get(message.eventId);
    if (source === undefined) {
      const access = options.accessRouteFor?.(message);
      source = turnModelAccessSource({
        controlPlaneUrl: options.controlPlaneUrl, signedFetch: options.signedFetchFor(message), turnId: message.eventId,
        ...(access === undefined ? {} : { orgId: access.orgId, route: { path: access.path, body: access.body } }),
        models: { classifier: options.classifierModel, ...(options.orchestratorModel === undefined ? {} : { orchestrator: options.orchestratorModel }) },
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      sources.set(message.eventId, source);
      if (sources.size > REMEMBERED_MESSAGES) sources.delete(sources.keys().next().value as string);
    }
    return source;
  };
  const proxyFor: ProxiedModels["proxyFor"] = (message) => turnModelProxy(sourceFor(message));
  return {
    proxyFor,
    async turnModels(message) {
      const proxy = await proxyFor(message);
      // RP-4: a classifier model the company forbids is replaced by the one the control plane names, or, when it names none, there is no classifier (every change no rule settles asks a person).
      const stated = (await sourceFor(message)()).classifierModel;
      const classifier: ActionClassifier = stated === null
        ? async () => { options.log("gate.classifier_blocked", { eventId: message.eventId }); throw new ClassifierError("the classifier is blocked by the company"); }
        : (await options.createClassifier({ model: stated ?? options.classifierModel, timeoutMs: options.classifierTimeoutMs, log: options.log, proxy })).classifier;
      // The route is the orchestrator's alone: the gate's classifier and the router keep their own models.
      const route = await turnModelRoute(sourceFor(message));
      return { proxy, classifier, ...(route === undefined ? {} : { route }) };
    },
    routerFor(message) {
      let made: ReturnType<typeof options.createRouter> | undefined;
      return async (text, signal) => {
        try {
          made ??= proxyFor(message).then(async (proxy) => {
            // RP-4: the router shares the classifier's model, so a blocked classifier leaves no router (the three-choice card is shown) and a replaced one is routed on the replacement.
            const stated = (await sourceFor(message)()).classifierModel;
            return stated === null ? undefined : options.createRouter({ classifierAvailable: true, model: stated ?? options.classifierModel, timeoutMs: options.classifierTimeoutMs, log: options.log, proxy });
          });
          const router = await made;
          return router === undefined ? { kind: "unclear", outcome: "unavailable" } : await router(text, signal);
        } catch (error) {
          options.log("route.router_unavailable", { eventId: message.eventId, errorName: error instanceof Error ? error.name : "unknown" });
          return { kind: "unclear", outcome: "unavailable" };
        }
      };
    },
  };
}
