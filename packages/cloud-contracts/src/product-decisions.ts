// Product decisions (W11, A-23, DN-6; experience decisions 14 and 36; owner answer Q8): a decision a task raises that is about the PRODUCT, not the code (a wording choice, a UX option, a scope question), with a
// risk tier. It is its own record, beside (never inside) a task's coding plan, design or merge, so nothing about how those are decided changes. Who may settle one is the one approval-place rule
// (`approvalPlaceDecision`, kind `product`): the task's owner and the project's maintainers at any risk; a collaborator only a LOW one, and only while the project's `collaboratorApprovals` switch is on.
// A product approval is stored with `class: "product"` and is read by nothing that decides a code review, a merge rule or CODEOWNERS.
//
// Also the project's switch `collaboratorApprovals` (decision 36): on by default; a maintainer (or a company owner or admin) changes it under the revision they read; every change is audited.
//
// Cloud-only names (Code has none of them). Browser-safe: zod only.
import { z } from "zod";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_HIDDEN, "one plain line");

export const PRODUCT_DECISION_RISKS = ["low", "medium", "high"] as const;
export const ProductDecisionRiskSchema = z.enum(PRODUCT_DECISION_RISKS);
export type ProductDecisionRisk = z.infer<typeof ProductDecisionRiskSchema>;

export const ProductDecisionIdSchema = z.string().regex(/^pdq_[A-Za-z0-9_-]{16,40}$/u);
export const ProductDecisionOptionIdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/u);

export const PRODUCT_DECISION_QUESTION_MAX = 300;
export const PRODUCT_DECISION_OPTION_MAX = 120;
export const PRODUCT_DECISION_OPTIONS_MAX = 4;
export const PRODUCT_DECISION_ANSWER_MAX = 2000;
/** The most answers one decision keeps; more is refused (the item stays bounded). */
export const PRODUCT_DECISION_ANSWERS_MAX = 20;
/** The most open product decisions one project lists. */
export const PRODUCT_DECISIONS_LIST_MAX = 50;

export const ProductDecisionOptionSchema = z.object({ id: ProductDecisionOptionIdSchema, label: line(PRODUCT_DECISION_OPTION_MAX) }).strict();
export type ProductDecisionOption = z.infer<typeof ProductDecisionOptionSchema>;

/** Who settled a decision, as the policy saw them: the task's owner, a maintainer, or a collaborator (a low decision under the switch). */
export const PRODUCT_DECIDER_ROLES = ["owner", "maintainer", "collaborator"] as const;
export const ProductDeciderRoleSchema = z.enum(PRODUCT_DECIDER_ROLES);
export type ProductDeciderRole = z.infer<typeof ProductDeciderRoleSchema>;

/** What `raiseProductDecision` takes: the question, two to four options, and the tier the raiser judged (deterministic, never lowered). */
export const ProductDecisionRaiseSchema = z.object({
  question: line(PRODUCT_DECISION_QUESTION_MAX),
  options: z.array(ProductDecisionOptionSchema).min(2).max(PRODUCT_DECISION_OPTIONS_MAX)
    .refine((options) => new Set(options.map((option) => option.id)).size === options.length, "option ids are unique"),
  risk: ProductDecisionRiskSchema,
}).strict();
export type ProductDecisionRaise = z.infer<typeof ProductDecisionRaiseSchema>;

export const ProductDecisionAnswerSchema = z.object({ by: z.object({ developerId: z.string().min(1).max(100), name: z.string().max(200) }).strict(), text: z.string().min(1).max(PRODUCT_DECISION_ANSWER_MAX), at: z.string().datetime() }).strict();

/** A product decision as the app reads it. */
export const ProductDecisionViewSchema = z.object({
  decisionId: ProductDecisionIdSchema,
  taskId: z.string().uuid(),
  project: z.string().min(1).max(100),
  question: line(PRODUCT_DECISION_QUESTION_MAX),
  options: z.array(ProductDecisionOptionSchema).min(2).max(PRODUCT_DECISION_OPTIONS_MAX),
  risk: ProductDecisionRiskSchema,
  status: z.enum(["open", "approved"]),
  /** Every change bumps it; a decide names the revision it read. */
  revision: z.number().int().min(1),
  raisedAt: z.string().datetime(),
  answers: z.array(ProductDecisionAnswerSchema).max(PRODUCT_DECISION_ANSWERS_MAX),
  approved: z.object({ optionId: ProductDecisionOptionIdSchema, by: z.object({ developerId: z.string(), name: z.string() }).strict(), role: ProductDeciderRoleSchema, at: z.string().datetime(), class: z.literal("product") }).strict().optional(),
  /** What the reader may do now, from their live role and the switch: the same rule the decide enforces. */
  you: z.object({ canAnswer: z.boolean(), canApprove: z.boolean(), approveRefusal: z.enum(["role_not_allowed", "collaborator_approvals_off", "fresh_sign_in_required"]).optional() }).strict(),
}).strict();
export type ProductDecisionView = z.infer<typeof ProductDecisionViewSchema>;

export const ProductDecisionsResponseSchema = z.object({ decisions: z.array(ProductDecisionViewSchema).max(PRODUCT_DECISIONS_LIST_MAX) }).strict();
export type ProductDecisionsResponse = z.infer<typeof ProductDecisionsResponseSchema>;

/** `POST /v1/app/projects/{name}/product-decisions/{decisionId}`: answer (a note; settles nothing) or approve one option (settles it). */
export const ProductDecisionDecideBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer"), requestId: z.string().uuid(), expectedRevision: z.number().int().min(1), text: z.string().min(1).max(PRODUCT_DECISION_ANSWER_MAX).regex(/^(?:[^\p{Cc}\p{Cf}]|[\n\t])*$/u, "no control characters except new lines and tabs") }).strict(),
  z.object({ action: z.literal("approve"), requestId: z.string().uuid(), expectedRevision: z.number().int().min(1), optionId: ProductDecisionOptionIdSchema }).strict(),
]);
export type ProductDecisionDecideBody = z.infer<typeof ProductDecisionDecideBodySchema>;
export const ProductDecisionDecideResponseSchema = z.object({ decision: ProductDecisionViewSchema }).strict();
export type ProductDecisionDecideResponse = z.infer<typeof ProductDecisionDecideResponseSchema>;

// ---- the project's switch (decision 36) ----

/** What the project read and the working-agreement source carry: the switch, its revision (0 = never changed, the default) and whether the reader may change it. */
export const CollaboratorApprovalsSettingSchema = z.object({ enabled: z.boolean(), revision: z.number().int().min(0), isDefault: z.boolean(), canChange: z.boolean() }).strict();
export type CollaboratorApprovalsSetting = z.infer<typeof CollaboratorApprovalsSettingSchema>;
/** On by default (decision 36). */
export const COLLABORATOR_APPROVALS_DEFAULT = true;

/** `PUT /v1/app/projects/{name}/collaborator-approvals`. */
export const CollaboratorApprovalsBodySchema = z.object({ requestId: z.string().uuid(), enabled: z.boolean(), expectedRevision: z.number().int().min(0) }).strict();
export type CollaboratorApprovalsBody = z.infer<typeof CollaboratorApprovalsBodySchema>;
export const CollaboratorApprovalsResponseSchema = z.object({ collaboratorApprovals: CollaboratorApprovalsSettingSchema }).strict();
export type CollaboratorApprovalsResponse = z.infer<typeof CollaboratorApprovalsResponseSchema>;
