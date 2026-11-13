// The web intake boundary: fixed choices only, never a classifier's explanation or customer text.
import { z } from "zod";
import { suggestionCardText, type RequestSuggestion } from "@rovara-code/contracts";

export const CODE_SUGGESTION_TEXT_MAX = 4000;
export const CodeSuggestionBodySchema = z.object({
  requestId: z.string().uuid(),
  text: z.string().min(1).max(CODE_SUGGESTION_TEXT_MAX).refine(text => text.trim().length > 0),
}).strict();
export const CodeSuggestionSchema = z.discriminatedUnion("reason", [
  z.object({ path: z.literal("quick"), reason: z.literal("small_change"), source: z.enum(["wording", "previous_wording"]) }).strict(),
  z.object({ path: z.literal("full"), reason: z.literal("large_change"), source: z.enum(["wording", "previous_wording"]) }).strict(),
  z.object({ path: z.literal("answer"), reason: z.literal("question"), source: z.enum(["wording", "previous_wording"]) }).strict(),
  z.object({ path: z.literal("answer"), reason: z.literal("unclear"), source: z.enum(["wording", "previous_wording"]) }).strict(),
  z.object({ path: z.literal("answer"), reason: z.literal("unavailable"), source: z.enum(["wording", "previous_wording"]) }).strict(),
]);
export type CodeSuggestion = z.infer<typeof CodeSuggestionSchema>;
export const CODE_SUGGESTION_UNAVAILABLE: CodeSuggestion = { path: "answer", reason: "unavailable", source: "wording" };

/** Code owns the wording. Only the first fixed line is needed here; Slack's bold markers are presentation. */
function plainSuggestion(suggestion: RequestSuggestion): string {
  return suggestionCardText(suggestion).split("\n", 1)[0]!.replace(/\*/gu, "");
}
export function codeSuggestionReason(reason: CodeSuggestion["reason"]): string {
  switch (reason) {
    case "small_change": return plainSuggestion("small_change");
    case "large_change": return plainSuggestion("large_change");
    case "question": return "This looks like a question. Let Rovara decide how to answer it.";
    case "unclear": return "Choose how Rovara should handle this, or let Rovara decide.";
    case "unavailable": return "No suggestion right now";
  }
}
