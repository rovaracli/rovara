// The stage-models fixture of the web tests, checked against the page's reader.
import { StageModelsReader } from "../../../packages/ui/src/api/stage-models.js";
import { stageModelsRaw } from "./stage-models-raw.js";
export { OPUS, SONNET, GPT, GEMINI, GROK, candidates, effective, stageEntry } from "./stage-models-raw.js";
export const stageModelsBody = (...input: Parameters<typeof stageModelsRaw>) => StageModelsReader.parse(stageModelsRaw(...input));
