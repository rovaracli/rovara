// The calls of the trial and billing screens (lane exp/trial-billing), written against the agreed API doc (briefs/trial-billing-api.md) while the server is built in a separate programme.
//   GET  /v1/app/trial                       any live member: phase, allowances, the caller's own figures, the trial-end choices
//   GET  /v1/app/org/billing                 owner or admin: plan, auto-billing, the MASKED payment method, past due, invoice count
//   GET  /v1/app/org/billing/invoices        owner or admin: invoices, newest first, paged by an opaque cursor
//   POST /v1/app/org/billing                 owner or admin, browser session only: one body per action (section 5 of the doc)
// The browser never handles card data: the payment method is read masked (brand and last four digits), and adding or changing a card is a provider-hosted page whose address the server returns.
// A server with `BillingEnabled` off answers the billing paths 404; the screens say so in plain words.
import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AppOrgMembersResponseReaderSchema } from "@agentx/contracts/web";
import { safeExternalUrl } from "../text/links.js";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

// ============================================================================================================================================================
// LOCAL SCHEMAS: these match the API doc EXACTLY (section 4 shapes, section 5 bodies and answer). They are here only because the server's contract file is not built yet.
// REPLACE this whole block with `TrialViewReaderSchema`, `BillingStateReaderSchema`, `InvoiceListReaderSchema`, `BillingActionBodySchema` and `BillingAnswerReaderSchema` from
// `@agentx/contracts/web` (`packages/contracts/src/app-billing.ts`) when they exist; nothing outside this block parses an answer.
// The contract's readers use `forwardReader`, so a word a newer server adds reads as "unknown": `forward` below does the same for every word list.
// ============================================================================================================================================================
const forward = <const T extends readonly [string, ...string[]]>(values: T) => z.union([z.enum(values), z.string().max(120).transform(() => "unknown" as const)]);
const iso = z.string().min(1).max(40);
const person = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/u), name: z.string().max(200) });
const amount = z.number().finite().nonnegative().max(1e12);
const PHASES = ["locked", "github_used", "active", "ended", "stopped", "own_key", "billed", "past_due", "suspended"] as const;
const AllowanceSchema = z.object({
 kind: forward(["models", "machine"]), unit: forward(["usd", "hours"]), refresh: forward(["monthly", "never"]),
 period: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u) }).nullable().optional(),
 granted: amount, used: amount, held: amount.optional(), left: amount, state: forward(["ok", "low", "used_up"]), source: z.string().max(40).optional(),
});
const ChoiceSetSchema = z.object({
 audience: forward(["you", "admins"]),
 decided: z.object({ choice: forward(["stop", "auto_bill", "own_key"]), by: person, at: iso }).nullable(),
 options: z.array(z.object({
  id: forward(["stop", "auto_bill", "own_key"]), available: z.boolean(), unavailableReason: forward(["not_built_yet", "billing_not_available", "no_payment_method"]).nullable(),
  summary: z.string().max(500), next: z.object({ href: z.string().max(300) }).optional(),
 })).max(10),
});
export const TrialViewReaderSchema = z.object({
 phase: forward(PHASES), plan: forward(["trial", "team"]), allowances: z.array(AllowanceSchema).max(10),
 you: z.object({ member: z.object({ limitUsd: amount, spentUsd: amount, committedUsd: amount }).nullable(), hitLimit: z.boolean(), canChoose: z.boolean() }),
 ends: z.object({ when: forward(["allowance_used", "monthly_refresh"]), text: z.string().max(500) }),
 choices: ChoiceSetSchema.nullable(),
});
const InvoiceSchema = z.object({
 invoiceId: z.string().min(1).max(120), number: z.string().max(80), period: z.object({ start: z.string().max(20), end: z.string().max(20) }),
 status: forward(["draft", "open", "paid", "void", "uncollectible"]), currency: z.string().regex(/^[A-Z]{3}$/u), totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 issuedAt: iso, dueAt: iso.nullable(), paidAt: iso.nullable(),
 lines: z.array(z.object({ kind: forward(["models", "machine", "adjustment"]), description: z.string().max(300), quantity: z.number().finite(), unit: forward(["usd_at_cost", "hours"]), amountMinor: z.number().int() })).max(200),
 hostedUrl: z.string().max(2048).nullable(), pdfUrl: z.string().max(2048).nullable(),
});
export const BillingStateReaderSchema = z.object({
 available: z.boolean(), provider: z.object({ configured: z.boolean() }), plan: forward(["trial", "team"]), phase: forward(PHASES),
 autoBill: z.object({ enabled: z.boolean(), available: z.boolean(), unavailableReason: forward(["billing_not_available", "no_payment_method"]).nullable(), monthlyCeilingUsd: amount.nullable() }),
 paymentMethod: z.object({
  kind: forward(["card", "bank_account", "other"]), brand: forward(["visa", "mastercard", "amex", "other"]).nullable().optional(), last4: z.string().regex(/^\d{4}$/u),
  expMonth: z.number().int().min(1).max(12).optional(), expYear: z.number().int().min(2000).max(2200).optional(), status: forward(["valid", "expiring", "expired", "failed"]), updatedAt: iso,
 }).nullable(),
 billingContact: z.object({ email: z.string().max(254) }).nullable(),
 pastDue: z.object({ since: iso, amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/u), retryAt: iso.nullable(), workPausesAt: iso.nullable() }).nullable(),
 invoices: z.object({ count: z.number().int().nonnegative(), latest: InvoiceSchema.nullable() }),
 portal: z.object({ available: z.boolean() }), lastEventAt: iso.nullable(),
});
export const InvoiceListReaderSchema = z.object({ invoices: z.array(InvoiceSchema).max(50), next: z.string().min(1).max(2000).optional() });
const requestId = z.uuid();
export const BillingActionBodySchema = z.discriminatedUnion("action", [
 z.object({ action: z.literal("choose-trial-end"), requestId, choice: z.enum(["stop", "auto_bill", "own_key"]) }).strict(),
 z.object({ action: z.literal("payment-method-setup"), requestId, returnPath: z.string().min(1).max(300) }).strict(),
 z.object({ action: z.literal("payment-method-remove"), requestId }).strict(),
 z.object({ action: z.literal("auto-bill"), requestId, enabled: z.boolean() }).strict(),
 z.object({ action: z.literal("portal"), requestId, returnPath: z.string().min(1).max(300) }).strict(),
 z.object({ action: z.literal("billing-contact"), requestId, email: z.string().trim().min(3).max(254) }).strict(),
]);
const redirect = z.object({ url: z.string().max(2048), expiresAt: iso });
// The doc's answer is `{ status, state, action? }` (section 5, "always"), and its table also names `{ setup }` and `{ portal }` for the two hosted-page actions. Both are read; `hostedPageUrl` takes whichever is there.
export const BillingAnswerReaderSchema = z.object({
 status: forward(["done", "needs_action"]), state: BillingStateReaderSchema,
 action: z.object({ kind: z.literal("redirect"), url: z.string().max(2048), expiresAt: iso }).optional(), setup: redirect.optional(), portal: redirect.optional(),
});
// ============================================================================================================================================================
// END OF LOCAL SCHEMAS
// ============================================================================================================================================================

export type TrialView = z.infer<typeof TrialViewReaderSchema>;
export type Allowance = TrialView["allowances"][number];
export type ChoiceSet = NonNullable<TrialView["choices"]>;
export type BillingState = z.infer<typeof BillingStateReaderSchema>;
export type PaymentMethod = NonNullable<BillingState["paymentMethod"]>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type BillingAnswer = z.infer<typeof BillingAnswerReaderSchema>;
/** An action without its `requestId`: the hook that sends it adds one, and keeps it for a repeat of the same press. */
export type BillingActionInput = z.input<typeof BillingActionBodySchema> extends infer Body ? Body extends { requestId: string } ? Omit<Body, "requestId"> : never : never;

export const TRIAL_PATH = "/v1/app/trial", BILLING_PATH = "/v1/app/org/billing", INVOICES_PAGE_SIZE = 10;
const NEVER = { retry: "never" } as const;

/** The https address of the provider-hosted page an answer carries, or undefined. Only https, no credentials, no control characters (`safeExternalUrl`); a card is entered there, never here. */
export function hostedPageUrl(answer: BillingAnswer): string | undefined {
 const raw = answer.action?.url ?? answer.setup?.url ?? answer.portal?.url;
 return raw === undefined ? undefined : safeExternalUrl(raw);
}

export function createTrialBillingApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  trial: () => api.get(TRIAL_PATH, TrialViewReaderSchema),
  billing: () => api.get(BILLING_PATH, BillingStateReaderSchema),
  /** Newest first. `cursor` is the `next` of the page before. */
  invoices: (cursor?: string) => api.get(BILLING_PATH + "/invoices?limit=" + String(INVOICES_PAGE_SIZE) + (cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)), InvoiceListReaderSchema),
  /** One press, sent once from the browser session (`retry: "never"`). The body is checked before it leaves. */
  send: (body: z.input<typeof BillingActionBodySchema>) => api.sendAnswer("POST", BILLING_PATH, BillingActionBodySchema.parse(body), BillingAnswerReaderSchema, NEVER),
  /** The people of the company, to name the owners and admins a member can ask. Any active member may read it. */
  members: () => api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema),
 };
}
export function useTrialBillingApi() { const host = useAppHost();return useMemo(() => createTrialBillingApi(host), [host]); }

export const trialKey = ["billing", "trial"] as const;
/** The owner and admin reads live under the admin cache area, so losing access (or switching company) drops them like every other admin read. */
export const billingKey = ["admin", "billing", "state"] as const;
export const invoicesKey = ["admin", "billing", "invoices"] as const;
export const askKey = ["billing", "people-to-ask"] as const;

export function useTrial(enabled = true) { const api = useTrialBillingApi();return useQuery({ queryKey: trialKey, queryFn: () => api.trial(), enabled, retry: false, staleTime: 60_000, refetchOnWindowFocus: true }); }
export function useBilling() { const api = useTrialBillingApi();return useQuery({ queryKey: billingKey, queryFn: () => api.billing(), retry: false, staleTime: 15_000, refetchOnWindowFocus: true }); }
export function useInvoices(enabled: boolean) {
 const api = useTrialBillingApi();
 return useInfiniteQuery({ queryKey: invoicesKey, queryFn: ({ pageParam }) => api.invoices(pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next, enabled, retry: false, refetchOnWindowFocus: false });
}
/** The names of the company's owners and admins, for "Ask an admin". A failed read gives none, and the page says "Ask an admin" without names. */
export function useAdminNames(enabled: boolean) {
 const api = useTrialBillingApi();
 return useQuery({
  queryKey: askKey, enabled, retry: false, staleTime: 60_000, refetchOnWindowFocus: false,
  queryFn: async () => (await api.members()).members.filter(member => member.role === "owner" || member.role === "admin").map(member => member.name).filter(name => name.trim() !== ""),
 });
}
