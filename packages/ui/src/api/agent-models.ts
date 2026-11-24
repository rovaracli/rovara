// DEC 254zzz84 (1): the company's per-step AI models (the "AI models" card). Cloud answers it from Rovara Code as the signed-in person
// (packages/cloud-server/src/agent-models-routes.ts). The reader is total over untrusted data: a body that is not the shape throws ("couldn't be read"), never half drawn.
export const AGENT_MODELS_PATH = "/v1/app/org/agent-models";
/** The steps a company can set, in the order a task runs them. Understand shares the plan's setting, and the security review the code review's (Code's edit groups). */
export const STEP_GROUPS = [
 { stage: "plan", label: "Understand and plan" },
 { stage: "plan_check", label: "Plan check" },
 { stage: "build", label: "Coding" },
 { stage: "code_review", label: "Code and security review" },
 { stage: "pull_request", label: "Pull request feedback" },
] as const;
export type StepStage = "understand" | "plan" | "plan_check" | "build" | "code_review" | "security_review" | "pull_request";
const STAGES: readonly string[] = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
const MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62})$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export interface StepModelRead {
 stage: StepStage;
 /** The model the company set for this step; null: it follows the company's model. */
 setting: string | null;
 /** The model the step runs on now; null when none can run it. */
 effective: { model: string; companyDefault: boolean; priceUsdPerMillion?: { input: number; output: number } } | null;
 refused: boolean;
}
export interface AgentModelsRead { revision: number; steps: StepModelRead[]; offered: string[]; canChange: boolean }

export function readAgentModels(body: unknown): AgentModelsRead {
 const fail = () => new Error("not the company's step models");
 if (!isRecord(body) || typeof body["revision"] !== "number" || !Number.isSafeInteger(body["revision"]) || body["revision"] < 0 || typeof body["canChange"] !== "boolean") throw fail();
 const offered = body["offered"], steps = body["steps"];
 if (!Array.isArray(offered) || offered.length === 0 || !offered.every(id => typeof id === "string" && MODEL.test(id)) || !Array.isArray(steps)) throw fail();
 const read: StepModelRead[] = steps.map((step: unknown) => {
  if (!isRecord(step) || typeof step["stage"] !== "string" || !STAGES.includes(step["stage"]) || typeof step["refused"] !== "boolean") throw fail();
  const setting = step["setting"];
  if (!(setting === null || (typeof setting === "string" && MODEL.test(setting)))) throw fail();
  const raw = step["effective"];
  let effective: StepModelRead["effective"] = null;
  if (raw !== null) {
   if (!isRecord(raw) || typeof raw["model"] !== "string" || !MODEL.test(raw["model"]) || typeof raw["companyDefault"] !== "boolean") throw fail();
   const price = raw["priceUsdPerMillion"];
   if (price !== undefined && (!isRecord(price) || !money(price["input"]) || !money(price["output"]))) throw fail();
   effective = { model: raw["model"], companyDefault: raw["companyDefault"], ...(price === undefined ? {} : { priceUsdPerMillion: { input: price["input"] as number, output: price["output"] as number } }) };
  }
  return { stage: step["stage"] as StepStage, setting, effective, refused: step["refused"] };
 });
 return { revision: body["revision"], steps: read, offered: (offered as string[]).slice(), canChange: body["canChange"] };
}

/** "$3 in / $15 out per million tokens", or undefined when the price isn't known. */
export function priceText(price: { input: number; output: number } | undefined): string | undefined {
 if (price === undefined) return undefined;
 // Two decimals from a dollar up ($3.30); up to three significant digits below ($0.075, $0.0004), never rounded to $0.00.
 const usd = (n: number) => `$${Number.isInteger(n) ? String(n) : n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)))}`;
 return `${usd(price.input)} in / ${usd(price.output)} out per million tokens`;
}
