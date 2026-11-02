// Decisions D1/D2 (owner Q1, accepted): on the Full path the requirements and the design read as ONE card with two tabs. It still records two approvals, one per document, so the Full
// contract and the audit do not change. The card itself is the ordinary `DecisionCard` (kind `approve_requirements`); the tabs travel beside it, keyed by the card's id, so the card
// contract is untouched. Browser-safe: nothing here imports a Node module.
import { z } from "zod";
import { DecisionCardIdSchema, DecisionCardReaderSchema, DecisionCardSchema, DECISION_CARDS_MAX, EvidenceChipSchema } from "./decision-cards.js";

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

export const DecisionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** A group of evidence lines a medium card shows in its panel: what the person must see that is NOT already on the front (names, not counts). `tab` names the document on a card with tabs. */
export const DecisionDetailGroupSchema = z
  .object({ tab: DecisionTabIdSchema.optional(), title: line(60), lines: z.array(line(200)).min(1).max(20) })
  .strict();
export type DecisionDetailGroup = z.infer<typeof DecisionDetailGroupSchema>;
export const DECISION_DETAIL_GROUPS_MAX = 12;
export const DecisionDetailGroupsSchema = z.array(DecisionDetailGroupSchema).max(DECISION_DETAIL_GROUPS_MAX);

/**
 * `GET /v1/app/decisions`: the cards, the tabs of the cards that have them, the evidence detail of each, and a `digests` entry per card: the digest of what the server is showing NOW (the card,
 * its tabs and the content version behind it: the document version, the pull request head). A client sends it back as `shownDigest` with `evidence-opened` and `approve`, so a person can only
 * open or approve what they were shown. `dropped` counts pending items that could not become a safe card; they are decided on their own page.
 */
export const DecisionCardsViewSchema = z
  .object({
    cards: z.array(DecisionCardSchema).max(DECISION_CARDS_MAX),
    total: z.number().int().min(0),
    tabs: z.record(DecisionCardIdSchema, DecisionTabsSchema),
    details: z.record(DecisionCardIdSchema, DecisionDetailGroupsSchema),
    digests: z.record(DecisionCardIdSchema, DecisionDigestSchema),
    dropped: z.number().int().min(0).max(100_000),
    /** High-risk cards whose source gave no confirmation page: they open the item's own page and make no fresh-sign-in claim. A source should supply one; this makes a missing one visible. */
    unconfirmed: z.array(DecisionCardIdSchema).max(DECISION_CARDS_MAX).optional(),
  })
  .strict()
  .refine((view) => [...Object.keys(view.tabs), ...Object.keys(view.details)].every((id) => view.cards.some((card) => card.id === id)), { message: "tabs and details belong to listed cards", path: ["tabs"] })
  .refine((view) => view.cards.every((card) => view.digests[card.id] !== undefined), { message: "every card has a digest", path: ["digests"] });
export type DecisionCardsView = z.infer<typeof DecisionCardsViewSchema>;

/**
 * What a client reads: a card a newer server changed still reads (the card reader keeps unknown fields and reads an unknown kind as "unknown"), and each card's tabs and details are checked one
 * by one by the client, so one bad entry hides one card's extras and not the list. NOTE: the reader drops the card schema's refinements, so a client must never rely on them (see `DecisionCard.tsx`).
 */
export const DecisionCardsViewReaderSchema = z.looseObject({
  cards: z.array(DecisionCardReaderSchema).max(DECISION_CARDS_MAX), total: z.number().int().min(0),
  tabs: z.record(z.string(), z.unknown()).optional(), details: z.record(z.string(), z.unknown()).optional(), digests: z.record(z.string(), z.unknown()).optional(), dropped: z.number().int().min(0).optional(),
});

/** `POST .../evidence-opened`: the digest the person was shown. */
export const DecisionOpenedBodySchema = z.object({ requestId: z.string().uuid(), shownDigest: DecisionDigestSchema }).strict();
export type DecisionOpenedBody = z.infer<typeof DecisionOpenedBodySchema>;

/** `POST /v1/app/decisions/{kind}/{subject}/approve`. `tab` is required on a card with tabs (one approval per tab) and refused on one without; `shownDigest` is what the person was shown. Not bulk: one card, one tab, one request. */
export const DecisionApproveBodySchema = z.object({ requestId: z.string().uuid(), shownDigest: DecisionDigestSchema, tab: DecisionTabIdSchema.optional() }).strict();
export type DecisionApproveBody = z.infer<typeof DecisionApproveBodySchema>;

/** What an approve or a reject answers when it was decided: the card, what was recorded and, on a card with tabs, which documents are still waiting. */
export const DecisionAnsweredSchema = z
  .object({
    cardId: DecisionCardIdSchema,
    outcome: z.enum(["approved", "rejected"]),
    tab: DecisionTabIdSchema.optional(),
    remainingTabs: z.array(DecisionTabIdSchema).max(2),
  })
  .strict();
export type DecisionAnswered = z.infer<typeof DecisionAnsweredSchema>;

/** `202`: the existing endpoint did not decide; the person decides on its confirmation page (a fresh sign-in). Nothing was approved, so no surface may say "Approved". */
export const DECISION_MERGING_MAX = 20;
/** What a merge press is about to merge, so the app can ask "Merge #N into <branch>?" before the person goes on to the confirmation page. Present only on a merge. */
export const DecisionMergingSchema = z.array(z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), baseBranch: z.string().min(1).max(255) }).strict()).min(1).max(DECISION_MERGING_MAX);
export const DecisionNeedsConfirmationSchema = z
  .object({ cardId: DecisionCardIdSchema, outcome: z.literal("needs_confirmation"), confirmUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "an https link"), merging: DecisionMergingSchema.optional() })
  .strict();
export type DecisionNeedsConfirmation = z.infer<typeof DecisionNeedsConfirmationSchema>;

/** What an approve or a reject answers: decided, or waiting on a confirmation page. */
export const DecisionOutcomeSchema = z.union([DecisionAnsweredSchema, DecisionNeedsConfirmationSchema]);
/** What the app reads: a field a newer server adds to either answer is kept, never a reason to refuse the answer (an older bundle's strict reader once refused `merging`). */
export const DecisionOutcomeReaderSchema = z.union([
  z.looseObject({ cardId: DecisionCardIdSchema, outcome: z.enum(["approved", "rejected"]), tab: DecisionTabIdSchema.optional(), remainingTabs: z.array(DecisionTabIdSchema).max(2) }),
  z.looseObject({ cardId: DecisionCardIdSchema, outcome: z.literal("needs_confirmation"), confirmUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "an https link"), merging: DecisionMergingSchema.optional() }),
]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** The fixed reasons a performer refuses, and what each means to the person. */
export const DECISION_REFUSAL_REASONS = ["forbidden", "stale", "second_person_required", "not_ready", "unsupported"] as const;
export type DecisionRefusalReason = (typeof DECISION_REFUSAL_REASONS)[number];

/** What `evidence-opened` answers. `recorded` is false for a card that needs no such record (a low-risk one). */
export const DecisionEvidenceOpenedAnswerSchema = z.object({ cardId: DecisionCardIdSchema, opened: z.literal(true), recorded: z.boolean() }).strict();
export type DecisionEvidenceOpenedAnswer = z.infer<typeof DecisionEvidenceOpenedAnswerSchema>;
