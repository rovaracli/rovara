// The calls of the trial and billing screens (lane exp/trial-billing), read through the server's own contract (`packages/contracts/src/app-billing.ts`, built by srv/trial-reads; design doc briefs/trial-billing-api.md).
//   GET  /v1/app/trial                       any live member: phase, allowances, the caller's own figures, the trial-end choices
//   GET  /v1/app/org/billing                 owner or admin: plan, auto-billing, the MASKED payment method, past due, invoice count
//   GET  /v1/app/org/billing/invoices        owner or admin: invoices, newest first, paged by an opaque cursor
//   POST /v1/app/org/billing                 owner or admin, browser session only: one body per action (section 5 of the doc)
// The browser never handles card data: the payment method is read masked (brand and last four digits), and adding or changing a card is a provider-hosted page whose address the server returns.
// A server with `BillingEnabled` off answers the billing paths 404; the screens say so in plain words.
import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { BillingActionBodySchema, BillingAnswerReaderSchema, BillingStateReaderSchema, InvoiceListReaderSchema, TrialViewReaderSchema } from "@agentx/cloud-contracts/web";
import { safeAppPath, safeExternalUrl } from "../text/links.js";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export type TrialView = z.infer<typeof TrialViewReaderSchema>;
export type Allowance = TrialView["allowances"][number];
export type ChoiceSet = NonNullable<TrialView["choices"]>;
export type BillingState = z.infer<typeof BillingStateReaderSchema>;
export type PaymentMethod = NonNullable<BillingState["paymentMethod"]>;
export type Invoice = z.infer<typeof InvoiceListReaderSchema>["invoices"][number];
export type BillingAnswer = z.infer<typeof BillingAnswerReaderSchema>;
/** An action without its `requestId`: the hook that sends it adds one, and keeps it for a repeat of the same press. */
export type BillingActionInput = z.input<typeof BillingActionBodySchema> extends infer Body ? Body extends { requestId: string } ? Omit<Body, "requestId"> : never : never;

export const TRIAL_PATH = "/v1/app/trial", BILLING_PATH = "/v1/app/org/billing", INVOICES_PAGE_SIZE = 10;
const NEVER = { retry: "never" } as const;

/** The https address of the provider-hosted page an answer carries (`action.kind` "redirect"), or undefined. Only https, no credentials, no control characters (`safeExternalUrl`); a card is entered there, never here. */
export function hostedPageUrl(answer: BillingAnswer): string | undefined {
 const action = answer.action;
 return action?.kind === "redirect" && typeof action.url === "string" ? safeExternalUrl(action.url) : undefined;
}
/** The page of this app an answer sends the person to (`action.kind` "navigate"), or undefined. Only a path inside the app. */
export function navigatePath(answer: BillingAnswer): string | undefined {
 const action = answer.action;
 return action?.kind === "navigate" && typeof action.href === "string" && safeAppPath(action.href) ? action.href : undefined;
}

/** The contract takes a plain path inside the app as the page the hosted page returns to (no query, no fragment). Anything else (a path with a query, a page outside `/app`) returns to the Billing page. */
export function billingReturnPath(path: string): string {
 const plain = path.split(/[?#]/u, 1)[0] ?? "";
 return /^\/app(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(plain) && plain.length <= 300 && !plain.split("/").some(part => part === "." || part === "..") ? plain : "/app/admin/billing";
}

export function createTrialBillingApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  trial: () => api.get(TRIAL_PATH, TrialViewReaderSchema),
  billing: () => api.get(BILLING_PATH, BillingStateReaderSchema),
  /** Newest first. `cursor` is the `next` of the page before. */
  invoices: (cursor?: string) => api.get(BILLING_PATH + "/invoices?limit=" + String(INVOICES_PAGE_SIZE) + (cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)), InvoiceListReaderSchema),
  /** One press, sent once from the browser session (`retry: "never"`). The body is checked before it leaves. */
  send: (body: z.input<typeof BillingActionBodySchema>) => api.sendAnswer("POST", BILLING_PATH, BillingActionBodySchema.parse("returnPath" in body ? { ...body, returnPath: billingReturnPath(body.returnPath) } : body), BillingAnswerReaderSchema, NEVER),
 };
}
export function useTrialBillingApi() { const host = useAppHost();return useMemo(() => createTrialBillingApi(host), [host]); }

export const trialKey = ["billing", "trial"] as const;
/** The owner and admin reads live under the admin cache area, so losing access (or switching company) drops them like every other admin read. */
export const billingKey = ["admin", "billing", "state"] as const;
export const invoicesKey = ["admin", "billing", "invoices"] as const;

export function useTrial(enabled = true) { const api = useTrialBillingApi();return useQuery({ queryKey: trialKey, queryFn: () => api.trial(), enabled, retry: false, staleTime: 60_000, refetchOnWindowFocus: true }); }
export function useBilling() { const api = useTrialBillingApi();return useQuery({ queryKey: billingKey, queryFn: () => api.billing(), retry: false, staleTime: 15_000, refetchOnWindowFocus: true }); }
export function useInvoices(enabled: boolean) {
 const api = useTrialBillingApi();
 return useInfiniteQuery({ queryKey: invoicesKey, queryFn: ({ pageParam }) => api.invoices(pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next, enabled, retry: false, refetchOnWindowFocus: false });
}
