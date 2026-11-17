# Spending limits: per-project and per-person overrides

These limits are about AGENT spending (the agent route and the eval cap). A project's product AI keeps its own product caps and lessons' learning calls keep the
company's learning cap; neither is limited by a project or person override (a damaged override still refuses them, since they share the reader). A call whose
task token carries no person skips the person limit.

The company's defaults are `settings.budgets` (written by `PUT /org/settings`). On top of them a company owner or admin can give one project or one
person a monthly limit of their own. The company's monthly cap stays the outer bound.

| Piece | Where |
|---|---|
| Store (one item per override, `COMPANY#<org>` / `<sortPrefix><id>`) | `packages/cloud-server/src/company-store.ts` (`SPEND_LIMIT_KINDS`), `company-dynamo.ts` |
| Routes: `GET /org/spend-limits`, `PUT /org/spend-limits/<segment>/<id>` | `packages/cloud-server/src/spend-limits-routes.ts` |
| Gateway read (strongly consistent, fail closed) | `packages/model-gateway/src/company-caps.ts` (`readSpendLimit`, `CompanyBudgetCaps`), table in `deploy.ts` (`GATEWAY_COMPANY_SPEND_LIMITS`) |
| Admin page | `packages/ui/src/screens/admin/spend-limits/SpendLimitsScreen.tsx`, table in `packages/ui/src/api/admin-spend-limits.ts` |

Rules: admins only (reads too); a fresh step-up only when a change raises the effective limit (removing an override raises it when the default is higher; no
limit counts as the highest). A raise also follows the company's rules for a loosening: `allow: false` refuses it, a second-person or two-approver rule (the
default rules) refuses it here (raise the company default in Company settings instead; lowering stays free), `deciders` are enforced, and the company's sign-in window applies; every write is conditional on the override as read and on the settings version the default came from; every change is audited
(`company.budget.changed`, subject `spend_limit:<kind>:<id>`, detail `raised|lowered|removed_raised|removed_lowered from=<micros|none> to=<micros|none>`); a missing item is the company default; an item that is not exactly this company's, kind's and
id's, or a failed read, refuses the call.

## Adding a kind

A kind is one entry in each of three tables, plus the point that enforces it.

1. `SPEND_LIMIT_KINDS` in `company-store.ts`: `kind`, `scope` (`project` or `person`: what the id is), `sortPrefix` (unique, and no prefix may begin another),
   `listKey` and `segment` (the answer's member and the PUT path), `max`, and `defaultOf(budgets)` (what applies without an override; null: no limit). The key
   builder, the validation, the store, the routes (one PUT route per entry), the audit subject and the answer all come from it.
2. `GATEWAY_COMPANY_SPEND_LIMITS.kinds` in `model-gateway/src/deploy.ts`: the same `kind`, `scope` and `sortPrefix`, and `caps`: the meter cap the limit replaces
   (`projectMonth`, `personMonth`; each cap by at most one kind, a test pins it), or null when something other than the meter enforces it.
3. `SPEND_LIMIT_TABLES` in `packages/ui/src/api/admin-spend-limits.ts`: `listKey`, `segment`, `scope`, which default the rows replace, and the table's title.
4. Enforcement. A kind with a meter cap needs nothing more. Any other kind is enforced by its own caller, which reads the limit with `readSpendLimit(db, table,
   kind, companyId, id)` and refuses on `null` (the item does not read) and on a throw (the read failed); `undefined` means none, use the default.

`tests/contract/model-gateway-spend-limits.test.ts` (both tables agree, key shape, isolation, fail-closed read, strong consistency),
`tests/unit/spend-limits-routes.test.ts` (every kind through the routes), `tests/unit/model-gateway-spend-limit-caps.test.ts` (every meter-cap kind through
`capsFor`) and `tests/web/admin-spend-limits.test.ts` (one table per entry) walk the tables, so a new entry is tested without a new test.

## Two kinds that are not agent limits (lead 4 L4-E)

Both are in every table above (`upkeep_month`, `answers_month`; `caps: null` at the gateway, so each is enforced by its own caller through `readSpendLimit`).
Neither is an agent limit: they do not change what `project_month` or `person_month` say.

| Kind | Scope and id | Default | Enforced by |
|---|---|---|---|
| `upkeep_month` | a project (`PUT /org/spend-limits/upkeep/<project>`) | $25 a month, $0 = no upkeep spend | `upkeep-cap.ts`, on the agent route |
| `answers_month` | the company (`PUT /org/spend-limits/answers/<company id>`; the id is the caller's own company, any other id is 404) | $20 a month (a placeholder until the first dry run) | `answers-route.ts` (`docs/model-gateway-learning.md`, "The answers route") |

The defaults are in `company-store.ts` (`UPKEEP_DEFAULT_MONTH_MICROS`, `ANSWERS_DEFAULT_MONTH_MICROS`) and at the gateway (`upkeep-cap.ts`, `answers-route.ts`); a contract test keeps them equal.
Raising either above its default is a raise like any other (fresh step-up, the company's loosening rules); lowering, even to $0, is not.

### Nightly upkeep (DEC 254z(2))

AI that a project's nightly upkeep spends by itself (repair drafts, mock drafts, wiki refresh) is held to the project's `upkeep_month` limit by the gateway.

- Origin: a call on the agent route whose TC-1 token has `src` = `nightly`. Today the nightly run is model-free, so no AI call carries that origin yet; Code mints it only for upkeep work. Any other `src` never meets the upkeep row and never reads the limit.
- The cap: the call's caps get `upkeepMonth` (the project's limit, else the default; $0 and "no limit source configured" both mean no upkeep spend). The meter adds the project's `upkeep` row (`MeterItem` "upkeep", per project per month, sort key `ROW#["upkeep",<project>,<month>]`) to the call's other rows, so the same call also counts in the task, person, project and company rows. The upkeep cap can only tighten what they allow.
- Before the call: the hold is taken before the key is read or anything is sent. A refusal by the upkeep row is `422 upkeep_paused` with the reason in the `x-rovara-upkeep-pause` header (`no_budget`, `monthly_limit`, `cost_too_high`) and fixed words. A limit item that does not read is `503`.
- The admin notice (inbox) is not here: the gateway holds no inbox. Code's nightly upkeep turns `upkeep_paused` into the admins' notice, once per pause.
- Corrections: a price correction moves the upkeep row like the others; a correction pushing it past its cap only sets the ledger's `capExceeded` flag (the corrections source has no `src`, so it passes no upkeep cap), and the next reserve is refused by the row's own committed total.
