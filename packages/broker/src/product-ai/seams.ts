// TE-F1e: the interfaces this lane CALLS and does not own, defined here behind injected dependencies so the function is built and tested on fakes now.
//
// F1-d (feat/te-f1d-product-ai-store, built in parallel) owns the product source store. Its agreed seam (te-f1d.md fork F4, te-f1e.md "Reconciled with the F1-d refresh"):
//   loadProductSourceForRow(deps, orgId, project, rowId) -> ProductSourceForRow | undefined    (packages/broker/src/product-ai/store.ts)
//   productAiSecretName(env, org, project, source), productAiProxySessionPolicy(secretArnPrefix, secretName)  (packages/broker/src/product-ai/secrets.ts)
//   recordProductSourceWarning(deps, orgId, project, sourceId, { status, at })                    (store.ts)
//   the company gate `productModels` (A1 list, default off), keys starting `product-ai#`.
// The types below are LOCAL STAND-INS for F1-d's, shaped exactly as the seam was agreed. When 9d merges F1-d, the stand-ins are replaced by imports from F1-d's files and the production wiring passes F1-d's
// functions; nothing in the handler changes (DONE.md lists it). F1-f implements GoogleTokenSource in its own files.
import type { OrgId } from "@rovara-code/contracts";

/** The effective caps of a source, after the company-ceiling clamp, in micro-dollars (F1-d fork F4/F8). For test calls only; an eval hold is bounded by the month and the company (DEC 203). */
export interface ProductSourceCaps {
  readonly taskMicros: number;
  readonly projectMonthMicros: number;
  readonly taskCalls: number;
  /** Enforced by the worker's bridge pre-caps (F1-c), not by the meter. */
  readonly taskConcurrent: number;
}

/** F1-d's read seam answer (no secret: the secret's name, ARN and version are metadata). */
export interface ProductSourceForRow {
  readonly orgId: OrgId;
  readonly project: string;
  readonly sourceId: string;
  readonly rowId: string;
  readonly scheme: string;
  readonly gatewayHost?: string;
  readonly vertex?: { readonly projectId: string; readonly location: string };
  /** An Azure OpenAI source's own resource host (a row that names only a domain suffix). */
  readonly resourceHost?: string;
  readonly secretName: string;
  readonly secretArn: string;
  readonly secretVersionId: string;
  readonly caps: ProductSourceCaps;
  readonly companyCeiling?: { readonly monthMicros?: number };
  readonly revision: number;
}

/** `loadProductSourceForRow` with its store dependencies already bound. Undefined for a missing source, another company's, "tests" off, or the row not enabled: one answer. */
export type ProductSourceLoader = (orgId: OrgId, project: string, rowId: string) => Promise<ProductSourceForRow | undefined>;

/** `recordProductSourceWarning` with its store dependencies bound: after a provider 401 or 403. Never throws to the caller (a failed write is logged as a fixed word). */
export type ProductSourceWarningRecorder = (orgId: OrgId, project: string, sourceId: string, warning: { readonly status: 401 | 403; readonly at: string }) => Promise<void>;

/** `productAiProxySessionPolicy(secretArnPrefix, secretName)`: the session policy narrowing a proxy session to the one secret. */
export type ProductAiProxySessionPolicy = (secretArnPrefix: string, secretName: string) => string;

/** The company gate `productModels` (A1). Off: the function answers `not_found` for every call. */
export type ProductModelsGate = (orgId: OrgId) => Promise<boolean>;

/** The Vertex token seam (te-f1e.md item 2). F1-f implements it in new files; until then the default answers the fixed refusal. */
export interface GoogleTokenSource {
  tokenFor(orgId: OrgId, source: ProductSourceForRow): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly notRun: string }>;
}
export const VERTEX_NOT_RUN_SENTENCE = "not run: Vertex needs the federation setup";
export const NO_GOOGLE_TOKEN_SOURCE: GoogleTokenSource = { tokenFor: async () => ({ ok: false, notRun: VERTEX_NOT_RUN_SENTENCE }) };
