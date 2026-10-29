// The stage-models fixture of the web tests, checked against lane C's strict schema.
import { StageModelsResponseSchema } from "@agentx/contracts/web";
import { stageModelsRaw } from "./stage-models-raw.js";
export { OPUS, SONNET, GPT, GEMINI, GROK, candidates, effective, mid, keyOf, stageEntry } from "./stage-models-raw.js";
export const stageModelsBody = (...input: Parameters<typeof stageModelsRaw>) => StageModelsResponseSchema.parse(stageModelsRaw(...input));
