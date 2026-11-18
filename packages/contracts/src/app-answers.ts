// Lead 4 slice J3 (DEC 254z-amend, 254z-amend2; designs-2026-11-17/wiki-and-just-answer-plan.md sections 1.3 and 3): the web door of the smart Just answer, as Rovara Code serves it (slice J1) and the
// fixed words Cloud answers for it. Browser-safe: it imports only zod.
//
// MIRROR of Code's `packages/contracts/src/answers.ts` (AnswerRequestSchema, AnswerResponseSchema, ANSWER_WORDS, ANSWER_LIMITS at b40976f3e on Code's local branch `pr/l4-answer-service`) and of
// `packages/contracts/src/start-suggest.ts` (lane `pr/l4-answer-web`), schema for schema and word for word:
//   POST /v1/app/projects/{project}/answers          -> AnswerResponseSchema        (Code POST /v1/app/projects/{project}/answers)
//   POST /v1/app/projects/{project}/code/suggest     -> StartSuggestResponseSchema  (Code POST /v1/app/projects/{project}/code/suggest)
// Cloud's server rebuilds each Code answer field by field into exactly these shapes (`packages/cloud-server/src/answers-routes.ts`), so the app reads them strictly. When Code's contract changes, change this
// file, that rebuild and the tests together.
//
// Rules the shapes carry:
//   - The answer's text is the model's, built only from sentences whose source Code found again in the code: still untrusted. It is bounded, free of control and format characters (new lines allowed) and drawn as
//     plain text, never as HTML or Markdown. The one action is fixed words; the model writes no button.
//   - An answer shows no cost, no confidence score and no model name. "not_set_up" says so in fixed words and offers no action: never a dead button.
//   - Nothing the browser sent is echoed back in a refusal.
import { z } from "zod";

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const NO_CONTROL_BUT_NEWLINES = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;

/** Code's limits that the page needs (ANSWER_LIMITS.sources and the request bounds). */
export const ANSWER_SOURCES_MAX = 8;
export const ANSWER_QUESTION_MAX = 1_000;
export const ANSWER_CONTEXT_MAX = 4_000;
export const ANSWER_TEXT_MAX = 6_000;
export const START_SUGGEST_TEXT_MAX = 4_000;
export const ANSWER_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/u;
export const ANSWER_THREAD_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/u;
export const ANSWER_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,119}$/u;

/** What the browser sends (Cloud adds `channel: "web"`; the browser never names a company, a person or a channel). `context` is information for the answer, never an instruction. */
export const AnswerAskBodySchema = z.object({
  requestId: z.string().regex(ANSWER_REQUEST_ID_PATTERN),
  question: z.string().trim().min(1).max(ANSWER_QUESTION_MAX).regex(NO_CONTROL_BUT_NEWLINES),
  threadId: z.string().regex(ANSWER_THREAD_PATTERN).optional(),
  context: z.string().max(300).regex(NO_CONTROL).optional(),
}).strict();
export type AnswerAskBody = z.infer<typeof AnswerAskBodySchema>;

export const ANSWER_OUTCOMES = ["answered", "partly", "not_found", "not_set_up"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

/** Code's fixed answer words (ANSWER_WORDS), word for word. */
export const ANSWER_WORDS = {
  notSetUp: "Answers are not set up here yet.",
  notFound: "I don't know. The wiki and the code I can read do not cover this.",
  partly: "I could not confirm all of this, so I left out what I could not find in the code.",
  wikiOutdated: "I checked the code: the wiki was out of date here.",
  ranOut: "I ran out of room before I could finish. A task can dig deeper.",
  taskButton: "Start a Quick task",
  projectNotFound: "project not found",
  rate: "You've asked a lot of questions lately. Try again a little later.",
  unavailable: "Couldn't answer that just now.",
  limitReached: "This project has reached its spending limit for now.",
  badRequest: "An answer needs a request ID and a question of 1 to 1,000 characters.",
} as const;

export const AnswerCitationSchema = z.object({
  n: z.number().int().min(1).max(ANSWER_SOURCES_MAX),
  repo: z.string().regex(NAME),
  path: z.string().min(1).max(256).regex(NO_CONTROL),
  line: z.number().int().min(1),
  lineEnd: z.number().int().min(1).optional(),
  commit: z.string().regex(COMMIT),
}).strict();
export type AnswerCitation = z.infer<typeof AnswerCitationSchema>;

export const AnswerActionSchema = z.object({
  kind: z.literal("quick_task"),
  label: z.literal(ANSWER_WORDS.taskButton),
  title: z.string().min(1).max(120).regex(NO_CONTROL),
}).strict();
export type AnswerAction = z.infer<typeof AnswerActionSchema>;

export const AnswerResponseSchema = z.object({
  answerId: z.string().regex(ANSWER_ID_PATTERN).optional(),
  threadId: z.string().regex(ANSWER_THREAD_PATTERN),
  outcome: z.enum(ANSWER_OUTCOMES),
  text: z.string().max(ANSWER_TEXT_MAX).regex(NO_CONTROL_BUT_NEWLINES),
  honesty: z.string().max(300).regex(NO_CONTROL_BUT_NEWLINES).optional(),
  unconfirmed: z.array(z.string().max(200).regex(NO_CONTROL_BUT_NEWLINES)).max(3),
  sources: z.array(AnswerCitationSchema).max(ANSWER_SOURCES_MAX),
  wikiPages: z.array(z.object({ pageId: z.string().regex(PAGE_ID), title: z.string().max(120).regex(NO_CONTROL) }).strict()).max(20),
  action: AnswerActionSchema.optional(),
}).strict();
export type AnswerResponse = z.infer<typeof AnswerResponseSchema>;

// ---- The start box's suggestion (DEC 173) ----------------------------------------------------------------------------------------------------------------------------------------------

export const StartSuggestBodySchema = z.object({
  requestId: z.string().regex(ANSWER_REQUEST_ID_PATTERN),
  text: z.string().trim().min(1).max(START_SUGGEST_TEXT_MAX).regex(NO_CONTROL_BUT_NEWLINES),
}).strict();
export type StartSuggestBody = z.infer<typeof StartSuggestBodySchema>;

export const START_SUGGEST_KINDS = ["small_talk", "unknown", "question", "small_change", "large_change", "unclear"] as const;
export const START_SUGGEST_CLASSIFIERS = ["ok", "unavailable", "failed"] as const;
export const START_SUGGEST_PICKS = ["answer", "quick", "full"] as const;
export type StartSuggestPick = (typeof START_SUGGEST_PICKS)[number];
export const START_SMALL_TALK_KINDS = ["greeting", "thanks", "help", "ack"] as const;

export const StartSuggestResponseSchema = z.object({
  kind: z.enum(START_SUGGEST_KINDS),
  classifier: z.enum(START_SUGGEST_CLASSIFIERS),
  pick: z.enum(START_SUGGEST_PICKS),
  smallTalk: z.enum(START_SMALL_TALK_KINDS).optional(),
}).strict();
export type StartSuggestResponse = z.infer<typeof StartSuggestResponseSchema>;

/** The start box's own words for small talk (Code sends only which kind; no model was asked). */
export const START_SMALL_TALK_WORDS: Record<(typeof START_SMALL_TALK_KINDS)[number], string> = {
  greeting: "Hi! Ask me a question about this project, or tell me a change you'd like.",
  thanks: "You're welcome!",
  help: "I can answer questions about this project's code, or start a task to change it. Say what you need.",
  ack: "Got it.",
};

/** Code's start-suggest words (START_SUGGEST_WORDS) and Cloud's own for the rest. The app shows these and nothing Code or the browser sent. */
export const START_SUGGEST_WORDS = {
  projectNotFound: "project not found",
  rate: "You've asked for a lot of suggestions lately. Try again a little later.",
  unavailable: "Couldn't suggest a path just now.",
  badRequest: "A suggestion needs a request ID and 1 to 4,000 characters of text.",
} as const;

/** Cloud's own words for the two routes. */
export const ANSWERS_WORDS = Object.freeze({
  notFound: ANSWER_WORDS.projectNotFound,
  invalid: "the request is not valid",
  notYet: "Answers aren't available on this Rovara yet.",
  notSetUp: ANSWER_WORDS.notSetUp,
  forbidden: "You can't ask about this project.",
  unavailable: ANSWER_WORDS.unavailable,
  rate: ANSWER_WORDS.rate,
  limitReached: ANSWER_WORDS.limitReached,
  suggestUnavailable: START_SUGGEST_WORDS.unavailable,
  suggestRate: START_SUGGEST_WORDS.rate,
});
export const ANSWERS_SENTENCES: ReadonlySet<string> = new Set(Object.values(ANSWERS_WORDS));
