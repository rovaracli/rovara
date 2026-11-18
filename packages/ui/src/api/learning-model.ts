// DEC 254zzz63 (Code #1075): the model the company's lessons learn with, for the card in Company settings, AI. Cloud answers from Rovara Code as the signed-in person
// (packages/cloud-server/src/learning-model-routes.ts). The reader is total over untrusted data: a body that is not the shape throws ("couldn't be read"), never half drawn.
export const LEARNING_MODEL_PATH = "/v1/app/org/learning-model";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LearningModelRead {
 /** What lessons learn with now: the company's own model, else this Rovara's default; null only where this Rovara's default is broken. */
 model: string | null;
 /** "company" once the company chose its own; "install" while it follows this Rovara's default. */
 source: "company" | "install";
 /** The Claude models the company's gateway offers it now; may be empty. */
 offered: string[];
 /** The model the picker starts on; null when none is offered. */
 preselect: string | null;
 /** Whether this person may change it (a company owner or admin). */
 canChange: boolean;
}
export function readLearningModel(body: unknown): LearningModelRead {
 const bad = () => new Error("not the lessons learning model");
 if (!isRecord(body)) throw bad();
 const { model, source, offered, preselect, canChange } = body;
 if (!(model === null || (typeof model === "string" && MODEL_ID.test(model))) || (source !== "company" && source !== "install") || typeof canChange !== "boolean") throw bad();
 if (!Array.isArray(offered) || !offered.every(id => typeof id === "string" && MODEL_ID.test(id)) || new Set(offered).size !== offered.length) throw bad();
 if (!(preselect === null || (typeof preselect === "string" && offered.includes(preselect))) || (preselect === null && offered.length > 0)) throw bad();
 return { model, source, offered: (offered as string[]).slice(), preselect, canChange };
}

/** "claude-haiku-5-5" reads "Claude Haiku 5.5"; any other id is shown as it is. */
export function learningModelLabel(id: string): string {
 const match = /^claude-([a-z]+)-(\d+)-(\d+)$/u.exec(id);
 return match === null ? id : `Claude ${match[1]!.charAt(0).toUpperCase()}${match[1]!.slice(1)} ${match[2]!}.${match[3]!}`;
}
