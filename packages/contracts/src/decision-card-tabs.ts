// Decisions D1/D2 (owner Q1, accepted): on the Full path the requirements and the design read as ONE card with two tabs. It still records two approvals, one per document, so the Full
// contract and the audit do not change. The card itself is the ordinary `DecisionCard` (kind `approve_requirements`); the tabs travel beside it, keyed by the card's id, so the card
// contract is untouched. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { DecisionCardIdSchema, DecisionCardSchema, DECISION_CARDS_MAX, EvidenceChipSchema } from "./decision-cards.js";

export const DECISION_TAB_IDS = ["requirements", "design"] as const;
export const DecisionTabIdSchema = z.enum(DECISION_TAB_IDS);
export type DecisionTabId = z.infer<typeof DecisionTabIdSchema>;

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");

export const DecisionTabSchema = z
  .object({ id: DecisionTabIdSchema, title: line(60), summary: line(300), evidence: z.array(EvidenceChipSchema).max(6), approved: z.boolean() })
  .strict();
export type DecisionTab = z.infer<typeof DecisionTabSchema>;

/** The tabs of a card, in reading order: requirements, then design. A card has both or none. */
export const DecisionTabsSchema = z
  .array(DecisionTabSchema)
  .length(2)
  .refine((tabs) => tabs[0]?.id === "requirements" && tabs[1]?.id === "design", { message: "the tabs are requirements, then design" });

/** `GET /v1/app/decisions`: the cards, and the tabs of the cards that have them. */
export const DecisionCardsViewSchema = z
  .object({
    cards: z.array(DecisionCardSchema).max(DECISION_CARDS_MAX),
    total: z.number().int().min(0),
    tabs: z.record(DecisionCardIdSchema, DecisionTabsSchema),
  })
  .strict()
  .refine((view) => Object.keys(view.tabs).every((id) => view.cards.some((card) => card.id === id)), { message: "tabs belong to listed cards", path: ["tabs"] });
export type DecisionCardsView = z.infer<typeof DecisionCardsViewSchema>;

/** `POST /v1/app/decisions/{id}/approve`. `tab` is required on a card with tabs (one approval per tab) and refused on one without. Not bulk: one card, one tab, one request. */
export const DecisionApproveBodySchema = z.object({ requestId: z.string().uuid(), tab: DecisionTabIdSchema.optional() }).strict();
export type DecisionApproveBody = z.infer<typeof DecisionApproveBodySchema>;
