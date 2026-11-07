// Home (Plan 5 Task 15): what needs one person's attention, as ranked cards. `GET /v1/app/home` answers `HomeResponse`; `POST /v1/app/home/cards/{cardId}/dismiss` answers `HomeDismissResponse`.
// Every shape has a strict server schema (`…Schema`) and a forward-compatible reader (`…ReaderSchema`, which keeps what a newer server adds and reads a kind or an action it doesn't know
// as "unknown"); a client reads with the reader and never builds a request from a button's words: it follows `href` with `method`, and shows no button that has none.
import { z } from "zod";
import { HOME_CARDS_MAX, HOME_CARD_BUTTONS_MAX, SessionIdSchema } from "./agent-sessions.js";
import { forwardReader } from "./forward-reader.js";

const InstantSchema = z.string().datetime();
const HOME_TEXT_MAX = 300;
const HOME_LABEL_MAX = 60;
const HOME_HREF_MAX = 2048;

/**
 * The kinds of card. Plan 5 fills `approval`, `spend_request`, `plan`, `pull_request` and `failure`; `question` and `offer` are for sources later plans register. `rule_suggestion` (v1.2 learning
 * loop) is one card per project with suggested rules to review, for the project's maintainers; an older client reads it as "unknown". Slice 5: `waiting_ticket` is a ticket that waits for a
 * member (Start, or "Not this one"), for the people who may start tasks in its project; `intake_source` is a watched tracker source that keeps failing, for the project's maintainers.
 */
export const HOME_CARD_KINDS = ["approval", "spend_request", "question", "plan", "pull_request", "failure", "offer", "rule_suggestion", "waiting_ticket", "intake_source"] as const;
export type HomeCardKind = (typeof HOME_CARD_KINDS)[number];
/** The kinds a person may dismiss; every other card goes away when it is done. */
export const HOME_DISMISSIBLE_KINDS = ["failure", "offer"] as const;
/** What a button does: `open` and `confirm` and `start` are pages to go to (a browser follows `href`); `retry` and `dismiss` are requests to send (`method` says which). */
export const HOME_BUTTON_ACTIONS = ["open", "confirm", "retry", "dismiss", "start"] as const;
/** The most characters of a card's reason. */
export const HOME_REASON_MAX = 200;
/** How long a dismissal is kept. */
export const HOME_DISMISS_DAYS = 30;
/** What dismissing a card that goes away when it is done answers. */
export const HOME_NOT_DISMISSIBLE = "This card goes away when it's done.";

/** `<kind>:<id>`: the kind, a colon and the id that kind uses (an approval id, a session id, …), nothing else. */
export const HOME_CARD_ID_PATTERN = /^(approval|spend_request|question|plan|pull_request|failure|offer|rule_suggestion|waiting_ticket|intake_source):[A-Za-z0-9_-]{1,150}$/u;
export const HomeCardIdSchema = z.string().regex(HOME_CARD_ID_PATTERN);

const HrefSchema = z.string().url().max(HOME_HREF_MAX).refine((value) => /^https?:\/\//iu.test(value), "href: a web address");

/** One thing a person can do about a card. `href` is the destination of the action and is present exactly when the caller may take it; `method` says how to follow it. */
export const HomeButtonSchema = z
  .object({
    label: z.string().min(1).max(HOME_LABEL_MAX),
    action: z.enum(HOME_BUTTON_ACTIONS),
    href: HrefSchema.optional(),
    method: z.enum(["GET", "POST"]).optional(),
  })
  .strict();
export type HomeButton = z.infer<typeof HomeButtonSchema>;

/** One card on Home. `reason` says why it is shown to this person; `sessionId` is present only for a session the person may view. */
export const HomeCardSchema = z
  .object({
    cardId: HomeCardIdSchema,
    kind: z.enum(HOME_CARD_KINDS),
    title: z.string().min(1).max(HOME_TEXT_MAX),
    reason: z.string().min(1).max(HOME_REASON_MAX),
    sessionId: SessionIdSchema.optional(),
    at: InstantSchema,
    buttons: z.array(HomeButtonSchema).max(HOME_CARD_BUTTONS_MAX),
  })
  .strict();
export type HomeCard = z.infer<typeof HomeCardSchema>;
export const HomeCardReaderSchema = forwardReader(HomeCardSchema);

/** The first `HOME_CARDS_MAX` cards in ranking order, and `total`: how many cards the person has now (read at most a fixed number from each source). */
export const HomeResponseSchema = z.object({ cards: z.array(HomeCardSchema).max(HOME_CARDS_MAX), total: z.number().int().min(0) }).strict();
export type HomeResponse = z.infer<typeof HomeResponseSchema>;
export const HomeResponseReaderSchema = forwardReader(HomeResponseSchema);

/** The answer to a dismissal, the first one and every repeat. */
export const HomeDismissResponseSchema = z.object({ cardId: HomeCardIdSchema, dismissed: z.literal(true) }).strict();
export type HomeDismissResponse = z.infer<typeof HomeDismissResponseSchema>;
export const HomeDismissResponseReaderSchema = forwardReader(HomeDismissResponseSchema);
