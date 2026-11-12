// exp/automations: the web app's calls for automations (chains and their triggers). Readers come from `@agentx/cloud-contracts/web` (app-automations.ts) wherever one exists.
// A few answers have no browser reader there yet (a chain's versions, its draft, its shares, a chain run list); those are read here with small local schemas that ignore fields
// they don't know. Every write carries a fresh requestId, so a retry is the same request. A 202 comes back as `needs_confirmation` / `needs_admin_approval` (client.ts#send).
import { useMemo } from "react";
import { z } from "zod";
import {
  AutomationChainResponseReaderSchema, AutomationChainWriteResponseReaderSchema, AutomationDeletedResponseReaderSchema, AutomationTriggerActivityResponseReaderSchema,
  AutomationTriggerListResponseReaderSchema, AutomationTriggerWriteResponseReaderSchema, ProjectAutomationsResponseReaderSchema, ProjectPeopleViewReaderSchema,
} from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type Reader, type SendResult } from "./client.js";

const Iso = z.string();
const VersionRow = z.object({ version: z.number().int(), digest: z.string().optional(), publishedBy: z.string().optional(), publishedAt: Iso, note: z.string().optional(), current: z.boolean() });
export const ChainVersionsReader = z.object({ versions: z.array(VersionRow) });
export type ChainVersionRow = z.infer<typeof VersionRow>;
/** `GET /v1/app/chains/{id}/draft` (edit access): the draft and what stops it being published. */
export const ChainDraftReader = z.object({
  draft: z.object({ revision: z.number().int().min(1), definition: z.unknown(), updatedAt: Iso.optional() }),
  problems: z.array(z.object({ path: z.string(), message: z.string() })).default([]),
});
const DraftSaved = z.object({ draft: z.object({ revision: z.number().int().min(1), definition: z.unknown().optional() }) });
const Share = z.object({ principal: z.object({ kind: z.string(), developerId: z.string().optional(), project: z.string().optional() }), level: z.string() });
export const ChainSharesReader = z.object({ shares: z.array(Share) });
const DisabledTriggers = z.array(z.object({ triggerId: z.string(), problems: z.array(z.object({ message: z.string().optional() })).default([]) })).default([]);
const PublishedReader = z.object({ version: z.object({ version: z.number().int() }), disabledTriggers: DisabledTriggers });
const ChainChanged = z.object({ chain: z.object({ chainId: z.string() }), disabledTriggers: DisabledTriggers });
const AccountableReader = z.object({ accountable: z.object({ developerId: z.string() }) });
const RunSummary = z.object({
  sessionId: z.string(), chain: z.object({ chainId: z.string(), name: z.string(), version: z.number().int() }), project: z.string(), status: z.string(), createdAt: Iso, updatedAt: Iso.optional(), endedAt: Iso.optional(),
  cost: z.object({ spentUsd: z.number(), runLimitUsd: z.number() }).optional(),
});
export const ChainRunsReader = z.object({ runs: z.array(RunSummary), next: z.string().optional() });
export type ChainRunRow = z.infer<typeof RunSummary>;
export type DisabledTrigger = z.infer<typeof DisabledTriggers>[number];

const segment = encodeURIComponent;
const fresh = () => crypto.randomUUID();
/** A new trigger's id: `ctr_` and 20 characters of 0-9 a-z. The `bi0` start is the project's built-in switch's, so it is never made here. */
export function newTriggerId(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(20)), id = "ctr_" + [...bytes].map(byte => "0123456789abcdefghijklmnopqrstuvwxyz"[byte % 36]!).join("");
    if (!id.startsWith("ctr_bi0")) return id;
  }
}

/** What the readers answer: a forward reader keeps a variant this build doesn't know as `kind: "unknown"`, so screens never assume the three they know. */
export type TriggerRead = z.output<typeof AutomationTriggerWriteResponseReaderSchema>["trigger"];
export type ChainRead = z.output<typeof AutomationChainResponseReaderSchema>["chain"];
export type ProjectTriggerRead = z.output<typeof ProjectAutomationsResponseReaderSchema>["triggers"][number];
export interface TriggerPutInput { project: string; spec: unknown; enabled?: boolean; maxRunsPerHour?: number; hookId?: string }

export function createAutomationsApi(host: AppHost) {
  const api = createApiClient(host), chain = (id: string) => "/v1/app/chains/" + segment(id), trigger = (chainId: string, triggerId: string) => chain(chainId) + "/triggers/" + segment(triggerId);
  const send = <T>(method: "POST" | "PUT" | "DELETE", path: string, body: Record<string, unknown>, reader: Reader<T>): Promise<SendResult<T>> => api.send(method, path, { requestId: fresh(), ...body }, reader);
  return {
    project: (project: string) => api.get("/v1/app/projects/" + segment(project) + "/automations", ProjectAutomationsResponseReaderSchema),
    people: (project: string) => api.get("/v1/app/projects/" + segment(project) + "/people", ProjectPeopleViewReaderSchema),
    chain: (id: string) => api.get(chain(id), AutomationChainResponseReaderSchema),
    versions: (id: string) => api.get(chain(id) + "/versions", ChainVersionsReader),
    draft: (id: string) => api.get(chain(id) + "/draft", ChainDraftReader),
    shares: (id: string) => api.get(chain(id) + "/shares", ChainSharesReader),
    triggers: (id: string) => api.get(chain(id) + "/triggers", AutomationTriggerListResponseReaderSchema),
    activity: (chainId: string, triggerId: string) => api.get(trigger(chainId, triggerId) + "/activity", AutomationTriggerActivityResponseReaderSchema),
    runs: (scope: { chain: string } | { project: string }) => api.get("/v1/app/chain-runs?" + ("chain" in scope ? "chain=" + segment(scope.chain) : "project=" + segment(scope.project)), ChainRunsReader),
    saveDraft: (id: string, expectedRevision: number, definition: unknown) => send("PUT", chain(id) + "/draft", { expectedRevision, definition }, DraftSaved),
    publish: (id: string, expectedDraftRevision: number, note?: string) => send("POST", chain(id) + "/publish", { expectedDraftRevision, ...(note === undefined || note.trim() === "" ? {} : { note: note.trim() }) }, PublishedReader),
    rollback: (id: string, version: number) => send("POST", chain(id) + "/rollback", { version }, ChainChanged),
    createChain: (project: string, name: string) => send("POST", "/v1/app/chains", { name, owner: { kind: "project", project } }, AutomationChainWriteResponseReaderSchema),
    archive: (id: string) => send("POST", chain(id) + "/archive", {}, AutomationChainWriteResponseReaderSchema),
    unarchive: (id: string) => send("POST", chain(id) + "/unarchive", {}, AutomationChainWriteResponseReaderSchema),
    setBudget: (id: string, monthlyUsd: number | null) => send("PUT", chain(id) + "/budget", { monthlyUsd }, ChainChanged),
    setAccountable: (id: string, developerId: string) => send("PUT", chain(id) + "/accountable", { accountable: { developerId } }, AccountableReader),
    putTrigger: (chainId: string, triggerId: string, input: TriggerPutInput) => send("PUT", trigger(chainId, triggerId), { ...input }, AutomationTriggerWriteResponseReaderSchema),
    deleteTrigger: (chainId: string, triggerId: string) => send("DELETE", trigger(chainId, triggerId), {}, AutomationDeletedResponseReaderSchema),
  };
}
export type AutomationsApi = ReturnType<typeof createAutomationsApi>;
export function useAutomationsApi(): AutomationsApi { const host = useAppHost();return useMemo(() => createAutomationsApi(host), [host]); }
export const automationsKey = (project: string) => ["automations", "project", project] as const;
export const chainKey = (id: string, part: string) => ["automations", "chain", id, part] as const;
