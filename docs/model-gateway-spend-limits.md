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

## People and limits (cost report slice A6)

`GET /org/people-limits[?project=<name>]` (`packages/cloud-server/src/people-limits-routes.ts`) and the admin page `/app/admin/money/people` show each current member's spend this month against
the limit that applies to them (their own override, else the company default `memberMonthlyUsd`), by NAME only. Owner rule (decision D2): per-person SPEND against LIMITS, visible to company
owners and admins only; no quality or speed number, no ranking, no merged or task count per person. The row has five fields (`developerId`, `name`, `spentCents`, `limitCents`, `limitSource`), the
server sends no other, and Spending carries no per-person table any more.

- People: Code's company member list as the admin (current members; a row filed under another company refuses the whole answer). The project filter narrows WHICH people are listed (the people
  Code lists on that project, intersected with the company's members). The gateway's meter has one row per person and month, not per project, so a person's spend is always their whole month.
- Limits: the override items and `settings.budgets` above. An override list that is partial, or an item that is not exactly this company's person item, refuses the answer.
- Spend: the gateway's person-month meter rows (`CO#[issuer,company]` / `ROW#["person",<person>,"YYYY-MM"]`, `spentMicros`) through `PersonSpendReader` (`gateway-meter-read.ts`,
  `DynamoGatewayMeterReader`: read-only `BatchGetItem` of exact keys, consistent reads, every row checked against the asked company and person). Spend rounds UP to whole cents, a limit rounds DOWN.
  A row that does not read refuses the whole answer; nobody is drawn as $0 for a number that could not be read.
- Setting it on: `scripts/cloud-lambda.ts` builds the reader from `CLOUD_GATEWAY_METER_TABLE` (the gateway's meter table name; the issuer is `<ROVARA_CODE_URL>/v1/auth`). The issuer must equal the gateway's `GATEWAY_INSTALL_ISSUER` exactly (check it when switching this on: a mismatch would find no rows and show everyone as $0). The amounts count finished calls only (`spentMicros`), not money held for running work. Unset, the route answers 501 and the
  page says "not connected yet". **Infrastructure not in this change (owner decision):** the Cloud server's role needs `dynamodb:BatchGetItem` on that table, conditioned on
  `dynamodb:LeadingKeys` `CO#*` (the pattern `productAi()` in `infra/lib/cloud-web.ts` uses for the product key table), plus the table name as a stack parameter and the env var. Until it is granted nothing reads the table.
- Changing a limit stays on Spending limits (B1): each row links to `/app/admin/money/limits?person=<id>`, which opens that person's add or edit form.
