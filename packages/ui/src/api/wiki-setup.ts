// The wiki panel on the project's setup page (lead 4 W6; Code's wiki-map W0 and wiki-build W4 routes, and the nightly upkeep seam, through Cloud). Code decides who may; this client only asks.
// A refusal is shown in fixed words (fixedWikiSetupWords), never other text. Every answer is read with a strict schema; no dollar figure is in any of them.
import { useMemo } from "react";
import {
  ProjectOverviewProjectSchema, SYSTEM_RUNS_PATH, SystemRunsBodySchema, SystemRunsViewSchema, WIKI_SETUP_PATHS, WIKI_SETUP_SENTENCES, WikiRequestBodySchema, WikiSetupBuildSchema, WikiSetupDeleteAnswerSchema, WikiSetupMapViewSchema, WikiSetupUpkeepSchema, WikiStartBodySchema, WikiSwitchBodySchema, WikiUpkeepBodySchema,
  type WikiStartBody,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { SystemRunsView, WikiSetupBuild, WikiSetupChip, WikiSetupMap, WikiSetupMapView, WikiSetupRepo, WikiSetupUpkeep, WikiSetupUpkeepCap, WikiSetupUpkeepSpend } from "@agentx/contracts/web";

const base = (name: string, tail: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/" + tail;
const P = WIKI_SETUP_PATHS;
const NEVER = { retry: "never" } as const;

export function createWikiSetupApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  map: (project: string) => api.get(base(project, P.map), WikiSetupMapViewSchema),
  makeMap: (project: string) => api.sendAnswer("POST", base(project, P.map), {}, WikiSetupMapViewSchema, NEVER),
  build: (project: string) => api.get(base(project, P.build), WikiSetupBuildSchema),
  start: (project: string, body: WikiStartBody) => api.sendAnswer("POST", base(project, P.build), WikiStartBodySchema.parse(body), WikiSetupBuildSchema, NEVER),
  continue: (project: string, requestId: string) => api.sendAnswer("POST", base(project, P.continue), WikiRequestBodySchema.parse({ requestId }), WikiSetupBuildSchema, NEVER),
  stop: (project: string, requestId: string) => api.sendAnswer("POST", base(project, P.stop), WikiRequestBodySchema.parse({ requestId }), WikiSetupBuildSchema, NEVER),
  refresh: (project: string, requestId: string) => api.sendAnswer("POST", base(project, P.refresh), WikiRequestBodySchema.parse({ requestId }), WikiSetupBuildSchema, NEVER),
  agents: (project: string, requestId: string, on: boolean) => api.sendAnswer("POST", base(project, P.agents), WikiSwitchBodySchema.parse({ requestId, on }), WikiSetupBuildSchema, NEVER),
  delete: (project: string, requestId: string) => api.sendAnswer("POST", base(project, P.delete), WikiRequestBodySchema.parse({ requestId }), WikiSetupDeleteAnswerSchema, NEVER),
  upkeep: (project: string) => api.get(base(project, P.upkeep), WikiSetupUpkeepSchema),
  /** The project switch (`allowSystemRuns` absent), or the setup choice: the company's consent AND the project switch in one act (`allowSystemRuns: true`, a company owner or admin; Code decides). */
  setUpkeep: (project: string, requestId: string, on: boolean, allowSystemRuns?: boolean) => api.sendAnswer("PUT", base(project, P.upkeep), WikiUpkeepBodySchema.parse({ requestId, on, ...(allowSystemRuns === undefined ? {} : { allowSystemRuns }) }), WikiSetupUpkeepSchema, NEVER),
  /** L4-P3: the company's one control over nightly upkeep (company owners and admins only; Code decides). */
  systemRuns: () => api.get(SYSTEM_RUNS_PATH, SystemRunsViewSchema),
  setSystemRuns: (requestId: string, allowed: boolean) => api.sendAnswer("PUT", SYSTEM_RUNS_PATH, SystemRunsBodySchema.parse({ requestId, allowed }), SystemRunsViewSchema, NEVER),
  /** The company's spending limits (company owners and admins only; Cloud's `/org/spend-limits`, lead 3 B1 and lead 4 L4-E): read for the nightly upkeep cap, written with the same body the Spending page sends. */
  capRead: () => api.get(SPEND_LIMITS_PATH, { parse: (body: unknown) => body }),
  capWrite: (project: string, expectedVersion: number, monthlyUsd: number | null) => api.sendAnswer("PUT", `${SPEND_LIMITS_PATH}/upkeep/${encodeURIComponent(project)}`, { expectedVersion, monthlyUsd }, { parse: (body: unknown) => body }, NEVER),
 };
}
export function useWikiSetupApi() { const host = useAppHost(); return useMemo(() => createWikiSetupApi(host), [host]); }
export const wikiSetupKey = (project: string, part: "map" | "build" | "upkeep" | "cap") => ["wiki-setup", project, part] as const;
/** The company control's own read (not a project's). */
export const systemRunsKey = ["wiki-setup", "company", "system-runs"] as const;

export const SPEND_LIMITS_PATH = "/v1/app/org/spend-limits";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export interface UpkeepCap {
 /** The monthly cap in dollars, or null when there is no cap (the answer said so). */
 usd: number | null;
 /** Whether this project has its own limit (else the company default applies). */
 own: boolean;
 /** The override's version (0 when there is none): sent back so a race is refused. */
 version: number;
}
/** The nightly upkeep cap of one project in the spending limits answer: its own row, else the company default for upkeep. undefined: the body is not that answer. Total over untrusted data. */
export function readUpkeepCap(body: unknown, project: string): UpkeepCap | undefined {
 if (!isRecord(body) || !isRecord(body["defaults"]) || !Array.isArray(body["upkeep"])) return undefined;
 const fallback = body["defaults"]["upkeepMonthlyUsd"];
 if (fallback !== null && !(typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0)) return undefined;
 for (const row of body["upkeep"] as unknown[]) {
  if (!isRecord(row) || typeof row["id"] !== "string") return undefined;
  if (row["id"] !== project) continue;
  const usd = row["monthlyUsd"], version = row["version"];
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return undefined;
  return { usd, own: true, version };
 }
 return { usd: fallback, own: false, version: 0 };
}
/** A dollar amount a person typed: 0 to 1,000,000 with at most two decimals ("5", "12.50", "$1,200"). undefined for anything else. */
export function parseUsd(text: string): number | undefined {
 const cleaned = text.trim().replace(/^\$/u, "").replace(/,/gu, "");
 if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(cleaned)) return undefined;
 const value = Number(cleaned);
 return value >= 0 && value <= 1_000_000 ? value : undefined;
}

/** Cloud says the wiki build is not on this Rovara's Code yet (or the project is gone): the setup page shows no wiki row at all. */
export const wikiSetupAbsent = (error: unknown) => error instanceof ApiError && (error.code === "NOT_ON_CODE_YET" || error.status === 501 || error.status === 404);
/** A refusal's words when they are one of the fixed wiki sentences, else the fallback (never the server's other text). */
export function fixedWikiSetupWords(error: unknown, fallback: string): string { return error instanceof ApiError && WIKI_SETUP_SENTENCES.has(error.message) ? error.message : fallback; }
