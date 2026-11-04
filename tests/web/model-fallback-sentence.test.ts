// QA-06 (staging 0.5.3): a task page said "Used sonnet-4-6 because sonnet-4-6 was unavailable". Tasks recorded before the broker fix still hold that note, so the page never says it.
import { expect, it } from "vitest";
import { fallbackSentence } from "../../packages/ui/src/screens/session/model-fallbacks.js";
const sonnet = "amazon-bedrock/us.anthropic.claude-sonnet-4-6", opus = "amazon-bedrock/us.anthropic.claude-opus-5-5";
it("names the model that was asked for", () => { expect(fallbackSentence({ stage: "plan_check", used: sonnet, wanted: opus })).toBe(`Used ${sonnet} because ${opus} was unavailable.`); });
it("says \"the preferred model\" when the note names none", () => { expect(fallbackSentence({ stage: "plan_check", used: sonnet, wanted: null })).toBe(`Used ${sonnet} because the preferred model was unavailable.`); });
it("never names the model that ran as the one that was unavailable (a note recorded before the fix)", () => { expect(fallbackSentence({ stage: "plan_check", used: sonnet, wanted: sonnet })).toBe(`Used ${sonnet} because the preferred model was unavailable.`); });
