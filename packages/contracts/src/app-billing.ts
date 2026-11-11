// Trial and billing (lane srv/trial-reads; design doc briefs/trial-billing-api.md): what the browser reads for the trial banner, the Spending page's allowance and the billing settings,
// and the shape of the actions programme M will add. Strict shapes are what the server sends; the `...ReaderSchema`s are what the app reads (`forwardReader`: a phase, choice or reason a newer
// server adds reads as "unknown"). Words, counts, dollars and hours only. NEVER a card number, a security code, a provider customer id, a provider payment-method id or a provider token: the
// payment method is masked (last four digits), and no provider is named anywhere. Browser-safe: nothing here imports a Node module.
//
// Today (this lane) only the three reads exist: `GET /v1/app/trial` (any live member), `GET /v1/app/org/billing` and `GET /v1/app/org/billing/invoices` (owner or admin, and only while the
// billing switch is on; otherwise 404). `BillingActionBodySchema` and `BillingAnswerReaderSchema` are the contract for the POST that programme M builds; no server route answers it yet.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/** `forwardReader` keeps a nullable schema as it is, so a nullable value is written as a union with null, which it does read forward. */
const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);

export const TRIAL_PHASES = ["locked", "github_used", "active", "ended", "stopped", "own_key", "billed", "past_due", "suspended"] as const;
export const TrialPhaseSchema = z.enum(TRIAL_PHASES);
export type TrialPhase = z.infer<typeof TrialPhaseSchema>;

export const TRIAL_END_CHOICES = ["stop", "auto_bill", "own_key"] as const;
export const TrialEndChoiceSchema = z.enum(TRIAL_END_CHOICES);
export type TrialEndChoice = z.infer<typeof TrialEndChoiceSchema>;

/** Why a choice is not available: a fixed code the app turns into words. Never a sentence from a provider. */
export const BILLING_UNAVAILABLE_REASONS = ["not_built_yet", "billing_not_available", "no_payment_method"] as const;
export const BillingUnavailableReasonSchema = z.enum(BILLING_UNAVAILABLE_REASONS);

/** The most invoices one page may hold (`?limit=` is 1 to this), and the page the app asks for by default. */
export const INVOICES_MAX_PAGE = 50;
export const INVOICES_DEFAULT_PAGE = 10;
export const INVOICE_ID_MAX = 120;
export const BILLING_ALLOWANCE_MAX = 10;
export const INVOICE_LINES_MAX = 200;

const Amount = z.number().finite().min(0).max(1e12);
const Iso = z.string().min(1).max(40);
/** A person: the id is 64 hex characters; the name is what the member list shows. Reserved for the "Ask an admin" names; the reads in this lane carry none. */
export const BillingPersonSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string().max(200) }).strict();
const Money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Currency = z.string().regex(/^[A-Z]{3}$/u);
const Https = z.string().max(2048).regex(/^https:\/\/[^\s\p{Cc}\p{Cf}]+$/u);

// ---- an allowance: one meter with a unit

export const AllowanceSchema = z.object({
  kind: z.enum(["models", "machine"]),
  unit: z.enum(["usd", "hours"]),
  /** `monthly` is today's placeholder, which renews at the start of each UTC month. `never` is the one-time allowance of a later release. The app reads this and never hard-codes "this month". */
  refresh: z.enum(["monthly", "never"]),
  /** Present when `refresh` is "monthly": the UTC month the figures are for. */
  period: orNull(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u) }).strict()),
  granted: Amount,
  /** Models: money already spent (`spentUsd`). Machine: hours used (recorded stops plus what runs now). */
  used: Amount,
  /** Models only: money held for work in progress (committed minus spent). */
  held: Amount.optional(),
  /** Models: the limit minus committed, never below 0. Machine: granted minus used, never below 0. */
  left: Amount,
  /** `low` from 80% (`BUDGET_WARNING_RATIO`), `used_up` at nothing left. */
  state: z.enum(["ok", "low", "used_up"]),
  /** Which model source this meters (`rovara`); a machine meter has none. */
  source: z.string().min(1).max(40).optional(),
}).strict();
export type Allowance = z.infer<typeof AllowanceSchema>;

// ---- the choices at the end of a trial

export const ChoiceOptionSchema = z.object({
  id: TrialEndChoiceSchema,
  available: z.boolean(),
  unavailableReason: orNull(BillingUnavailableReasonSchema),
  summary: z.string().min(1).max(500),
  /** A page in this app that does the work (only `own_key` has one). */
  next: z.object({ href: z.string().regex(/^\/app\/[A-Za-z0-9._~/-]{0,200}$/u) }).strict().optional(),
}).strict();

export const ChoiceSetSchema = z.object({
  /** Why this person is told: `you` they hit the limit; `admins` they are an owner or admin of the company. */
  audience: z.enum(["you", "admins"]),
  /** The choice an owner or admin made. Always null until programme M records choices. */
  decided: orNull(z.object({ choice: TrialEndChoiceSchema, by: BillingPersonSchema, at: Iso }).strict()),
  options: z.array(ChoiceOptionSchema).max(10),
}).strict();

// ---- GET /v1/app/trial

export const TrialViewSchema = z.object({
  phase: TrialPhaseSchema,
  plan: z.enum(["trial", "team"]),
  /** The company's meters: models in US dollars and machine time in hours. Empty while the trial is locked or its GitHub account was used by another company, and for a company with no limit. */
  allowances: z.array(AllowanceSchema).max(BILLING_ALLOWANCE_MAX),
  you: z.object({
    /** The caller's own monthly figures; null when no limit applies to them. */
    member: orNull(z.object({ limitUsd: Amount, spentUsd: Amount, committedUsd: Amount }).strict()),
    /** An allowance is used up, so the caller's next start would be refused for it. (No refusal is recorded; this is read from the figures.) */
    hitLimit: z.boolean(),
    /** An owner or admin (the people who may choose at the end of a trial). */
    canChoose: z.boolean(),
  }).strict(),
  /** What happens at the end, as a fixed sentence from the server. */
  ends: z.object({ when: z.enum(["allowance_used", "monthly_refresh"]), text: z.string().min(1).max(500) }).strict(),
  /** Present when an allowance is low or used up and this person is told (owners and admins; anyone else who hit the limit); null otherwise. */
  choices: orNull(ChoiceSetSchema),
}).strict();
export type TrialView = z.infer<typeof TrialViewSchema>;
export const TrialViewReaderSchema = forwardReader(TrialViewSchema);
export type ReadTrialView = z.output<typeof TrialViewReaderSchema>;

// ---- an invoice (GET /v1/app/org/billing/invoices; none exist until a billing provider does)

export const InvoiceLineSchema = z.object({
  kind: z.enum(["models", "machine", "adjustment"]),
  description: z.string().max(300),
  quantity: z.number().finite(),
  unit: z.enum(["usd_at_cost", "hours"]),
  amountMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const InvoiceSchema = z.object({
  /** Opaque, at most 120 characters. Never a provider id. */
  invoiceId: z.string().min(1).max(INVOICE_ID_MAX),
  number: z.string().max(80),
  period: z.object({ start: z.string().max(20), end: z.string().max(20) }).strict(),
  status: z.enum(["draft", "open", "paid", "void", "uncollectible"]),
  currency: Currency,
  /** Integer minor units (cents). Invoice money is never a float, and is never mixed with an allowance's dollars. */
  totalMinor: Money,
  issuedAt: Iso, dueAt: orNull(Iso), paidAt: orNull(Iso),
  lines: z.array(InvoiceLineSchema).max(INVOICE_LINES_MAX),
  /** https only. */
  hostedUrl: orNull(Https), pdfUrl: orNull(Https),
}).strict();
export type Invoice = z.infer<typeof InvoiceSchema>;

export const InvoiceListSchema = z.object({ invoices: z.array(InvoiceSchema).max(INVOICES_MAX_PAGE), next: z.string().min(1).max(2000).optional() }).strict();
export type InvoiceList = z.infer<typeof InvoiceListSchema>;
export const InvoiceListReaderSchema = forwardReader(InvoiceListSchema);

// ---- GET /v1/app/org/billing

export const PaymentMethodSchema = z.object({
  kind: z.enum(["card", "bank_account", "other"]),
  brand: orNull(z.enum(["visa", "mastercard", "amex", "other"])).optional(),
  /** The ONLY digits ever returned. */
  last4: z.string().regex(/^\d{4}$/u),
  expMonth: z.number().int().min(1).max(12).optional(),
  expYear: z.number().int().min(2000).max(2200).optional(),
  status: z.enum(["valid", "expiring", "expired", "failed"]),
  updatedAt: Iso,
}).strict();

export const BillingStateSchema = z.object({
  /** False while no billing provider is configured (today). */
  available: z.boolean(),
  /** Never names the provider. */
  provider: z.object({ configured: z.boolean() }).strict(),
  plan: z.enum(["trial", "team"]),
  phase: TrialPhaseSchema,
  autoBill: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    unavailableReason: orNull(z.enum(["billing_not_available", "no_payment_method"])),
    /** The company's monthly limit, which caps auto-billed use; null when none is set. */
    monthlyCeilingUsd: orNull(Amount),
  }).strict(),
  paymentMethod: orNull(PaymentMethodSchema),
  billingContact: orNull(z.object({ email: z.string().max(254) }).strict()),
  pastDue: orNull(z.object({ since: Iso, amountMinor: Money, currency: Currency, retryAt: orNull(Iso), workPausesAt: orNull(Iso) }).strict()),
  invoices: z.object({ count: z.number().int().min(0), latest: orNull(InvoiceSchema) }).strict(),
  /** A provider-hosted page for tax ids, address and receipts. */
  portal: z.object({ available: z.boolean() }).strict(),
  lastEventAt: orNull(Iso),
}).strict();
export type BillingState = z.infer<typeof BillingStateSchema>;
export const BillingStateReaderSchema = forwardReader(BillingStateSchema);
export type ReadBillingState = z.output<typeof BillingStateReaderSchema>;

// ---- POST /v1/app/org/billing (programme M: the contract only; no route answers it yet)

const RequestId = z.string().uuid();
/** A relative path inside this app, never a full address: the provider's hosted page returns the person here. */
export const BillingReturnPathSchema = z.string().min(1).max(300)
  .regex(/^\/app(?:\/[A-Za-z0-9._~-]+)*\/?$/u)
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "not a path inside the app");

export const BillingActionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose-trial-end"), requestId: RequestId, choice: TrialEndChoiceSchema }).strict(),
  z.object({ action: z.literal("payment-method-setup"), requestId: RequestId, returnPath: BillingReturnPathSchema }).strict(),
  z.object({ action: z.literal("payment-method-remove"), requestId: RequestId }).strict(),
  z.object({ action: z.literal("auto-bill"), requestId: RequestId, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("portal"), requestId: RequestId, returnPath: BillingReturnPathSchema }).strict(),
  z.object({ action: z.literal("billing-contact"), requestId: RequestId, email: z.string().trim().min(3).max(254) }).strict(),
]);
export type BillingActionBody = z.infer<typeof BillingActionBodySchema>;

/**
 * The one answer shape of every action (design doc section 5, "always"): the new state, and what the person does next. `redirect` is a provider-hosted page (payment method, portal): the
 * address is https only. `navigate` is a page in this app (`own_key` sends the person to the models page). There is no `{ setup }` or `{ portal }` variant: both hosted pages answer `redirect`.
 */
export const BillingNextActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("redirect"), url: Https, expiresAt: Iso }).strict(),
  z.object({ kind: z.literal("navigate"), href: z.string().regex(/^\/app\/[A-Za-z0-9._~/-]{0,200}$/u) }).strict(),
]);
export const BillingAnswerSchema = z.object({ status: z.enum(["done", "needs_action"]), state: BillingStateSchema, action: BillingNextActionSchema.optional() }).strict();
export type BillingAnswer = z.infer<typeof BillingAnswerSchema>;
export const BillingAnswerReaderSchema = forwardReader(BillingAnswerSchema);
