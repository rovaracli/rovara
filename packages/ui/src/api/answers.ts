// The smart Just answer's web door and the start box's path suggestion (lead 4 J3; Code's answer service J1 and its start-suggest route, through Cloud). Code decides who may ask; this client only sends and
// reads. Every refusal is shown in Cloud's fixed words (fixedAnswerWords), never other text. The answer text is the model's: every answer is read with a strict, bounded schema and drawn as plain text.
// Sent once from the browser (`retry: "never"`): the same requestId is the same question, so a retried press never asks twice.
import { useMemo } from "react";
import { ANSWERS_SENTENCES, AnswerHistoryResponseSchema, AnswerResponseSchema, NotRightResponseSchema, ProjectOverviewProjectSchema, StartSuggestResponseSchema, type AnswerAskBody, type AnswerResponse, type NotRightResponse, type StartSuggestBody, type StartSuggestResponse } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { useNav } from "../screens/account/use-nav.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";

export type { AnswerAskBody, AnswerAction, AnswerCitation, AnswerOutcome, AnswerResponse, StartSuggestBody, StartSuggestPick, StartSuggestResponse } from "@agentx/contracts/web";

const NEVER = { retry: "never" } as const;
const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name));

export function createAnswersApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  history: (project: string, taskId: string) => api.get(base(project) + "/tasks/" + encodeURIComponent(taskId) + "/answers", AnswerHistoryResponseSchema, undefined, NEVER),
  ask: (project: string, body: AnswerAskBody): Promise<AnswerResponse> => api.sendAnswer("POST", base(project) + "/answers", body, AnswerResponseSchema, NEVER),
  /** "Not right" on an answer (lead 4 J5): the asker's own press, an empty body, sent once. */
  notRight: (project: string, answerId: string): Promise<NotRightResponse> => api.sendAnswer("POST", base(project) + "/answers/" + encodeURIComponent(AnswerResponseSchema.shape.answerId.unwrap().parse(answerId)) + "/not-right", {}, NotRightResponseSchema, NEVER),
  suggest: (project: string, body: StartSuggestBody): Promise<StartSuggestResponse> => api.sendAnswer("POST", base(project) + "/code/suggest", body, StartSuggestResponseSchema, NEVER),
 };
}
export function useAnswersApi() { const host = useAppHost(); return useMemo(() => createAnswersApi(host), [host]); }

/**
 * Whether this Cloud offers the smart Just answer at all (DEC 254z-amend2): the deployment's setting, read from the nav the shell already makes. False while the nav is loading or the setting is off:
 * no Ask box is drawn, the start box starts work as it always did, and no answers request is made.
 */
export function useAnswersEnabled(): boolean { return useNav()?.features?.answers === true; }

/** A refusal's words when they are one of Cloud's fixed answer sentences, else the fallback (never the server's other text). */
export function fixedAnswerWords(error: unknown, fallback: string): string { return error instanceof ApiError && ANSWERS_SENTENCES.has(error.message) ? error.message : fallback; }
