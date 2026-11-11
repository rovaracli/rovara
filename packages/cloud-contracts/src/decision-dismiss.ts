// Approval place (U4, A-49): the "Not now" body and answer of a decision card. The rest of the decision card contract is Rovara Code's (`decision-card-tabs.ts`); these two shapes were added beside it
// by the approval-place lane and are not in Code yet, so Cloud holds them here. UPSTREAM OWED: when Code's decision-card-tabs.ts carries them and the vendor pin includes it, delete this file and import the
// names from @rovara-code/contracts.
import { z } from "zod";
import { DecisionCardIdSchema, DecisionDigestSchema } from "@rovara-code/contracts";

/**
 * `POST /v1/app/decisions/{kind}/{subject}/dismiss` (approval place, A-49): "Not now" from a chat. It hides nothing else and decides nothing: the card stays waiting, the person's dismissal is only remembered. It is never a rejection
 * (a rejection needs a signed-in session). `shownDigest` is what the message showed: a changed card is refused as stale.
 */
export const DecisionDismissBodySchema = z.object({ requestId: z.string().uuid(), shownDigest: DecisionDigestSchema }).strict();
export type DecisionDismissBody = z.infer<typeof DecisionDismissBodySchema>;
/** What a dismissal answers: the card, and that it is still waiting. */
export const DecisionDismissedSchema = z.object({ cardId: DecisionCardIdSchema, outcome: z.literal("dismissed") }).strict();
export type DecisionDismissed = z.infer<typeof DecisionDismissedSchema>;
