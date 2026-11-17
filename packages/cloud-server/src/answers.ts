// The body of POST /v1/app/sessions/{id}/answers (the owner's answers to the questions Understand asked), checked at runtime before any of it goes to
// Code's POST /v1/dev/tasks/{taskId}/answers. The limits are Code's own (Rovara Code's TaskAnswersRequestSchema and IntentAnswerSchema): one to three
// answers, a question id q1 to q3, an option id a to d, words of 1 to 2,000 characters. Only requestId, round and the answers go to Code; `revision`
// (the workflow revision the page read) is checked when the page sends it but is not forwarded (Code's stale-form guard is the round). Anything else
// in the body is dropped. The refusal words are fixed: they name the field, never its value.

export interface AnswerInput { questionId: string; optionId?: string; text?: string }
/** What Cloud sends to Code: exactly these fields. */
export interface AnswersBody { requestId: string; round: number; answers: AnswerInput[] }

/** At most this many answers in one call (Code asks 3 questions at most, INTENT_QUESTIONS_MAX). */
export const ANSWERS_MAX = 3;
/** The longest answer text, as Code takes it (INTENT_ANSWER_MAX_CHARS). */
export const ANSWER_TEXT_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Code's question ids (q1 to q3) and option ids (a to d). */
const QUESTION_ID = /^q[1-3]$/u;
const OPTION_ID = /^[a-d]$/u;
const WHOLE_MAX = 1_000_000;

export const ANSWERS_REFUSED = {
  body: "The answers must be a JSON object.",
  requestId: "requestId must be a UUID.",
  round: "round must be a whole number from 1 to 1,000,000.",
  revision: "revision must be a whole number from 0 to 1,000,000.",
  list: `answers must list 1 to ${String(ANSWERS_MAX)} answers.`,
  answer: "Each answer needs a questionId (q1 to q3) and an optionId (a to d), some text, or both.",
  text: `An answer's text is 1 to ${ANSWER_TEXT_MAX.toLocaleString("en-US")} characters.`,
} as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown, least: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= least && value <= WHOLE_MAX;

export function parseAnswersBody(body: unknown): { ok: true; value: AnswersBody } | { ok: false; message: string } {
  const refuse = (message: string) => ({ ok: false as const, message });
  if (!isObject(body)) return refuse(ANSWERS_REFUSED.body);
  const { requestId, round, revision, answers } = body;
  if (typeof requestId !== "string" || !UUID.test(requestId)) return refuse(ANSWERS_REFUSED.requestId);
  if (!whole(round, 1)) return refuse(ANSWERS_REFUSED.round);
  if (revision !== undefined && !whole(revision, 0)) return refuse(ANSWERS_REFUSED.revision);
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > ANSWERS_MAX) return refuse(ANSWERS_REFUSED.list);
  const kept: AnswerInput[] = [];
  for (const answer of answers as unknown[]) {
    if (!isObject(answer)) return refuse(ANSWERS_REFUSED.answer);
    const { questionId, optionId, text } = answer;
    if (typeof questionId !== "string" || !QUESTION_ID.test(questionId)) return refuse(ANSWERS_REFUSED.answer);
    if (optionId !== undefined && (typeof optionId !== "string" || !OPTION_ID.test(optionId))) return refuse(ANSWERS_REFUSED.answer);
    if (text !== undefined && (typeof text !== "string" || text.length < 1 || text.length > ANSWER_TEXT_MAX)) return refuse(ANSWERS_REFUSED.text);
    if (optionId === undefined && text === undefined) return refuse(ANSWERS_REFUSED.answer);
    kept.push({ questionId, ...(optionId === undefined ? {} : { optionId }), ...(text === undefined ? {} : { text }) });
  }
  return { ok: true, value: { requestId, round, answers: kept } };
}
