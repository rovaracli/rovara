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

### The upkeep cap read (L4-CAPR)

Code's nightly wiki refresh starts AI by itself only while the gateway itself says the project's upkeep cap is enforced (Code's `UpkeepCapReadSchema`, `contracts/upkeep.ts`). `src/upkeep-cap-read.ts`:

- `GET /v1/service/companies/<company>/upkeep/<project>` answers exactly `{ version: 1, company, project, month, enforced: true, limitMicros, spentMicros }`; no body, no query (a query is the 404). `month` is the UTC month of the gateway's clock.
- Token: the install's task key signs a service token, verified as the offered-models token is: header `typ` `rovara-service+jwt`, audience `rovara-model-gateway-upkeep-cap`, claims exactly `iss/aud/jti/iat/nbf/exp/cid`, at most 60 seconds of life, pinned issuer and key ids. The company in the path must be the token's `cid` (else the fixed 401, so another company's token learns nothing); the project is the path's own name (Code's name pattern). A task token, the offered-models token or any `x-api-key` never opens it.
- `limitMicros` is read through the same `UpkeepLimits` the agent route's upkeep call uses: the project's own `upkeep_month` item, else `UPKEEP_DEFAULT_MONTH_MICROS` (the route enforces that default for a project with no item, so the read states it); a `$0` item answers `limitMicros: 0` (enforced, no upkeep spend). `spentMicros` is the meter's own `upkeep` row for that company, project and month (settled spend; open holds are not in it).
- Fail closed: a limit item that does not read, a failed read of either store, a meter row that is missing, another company's or not a whole number, or a month change while reading is `503 unavailable`. `enforced: true` appears only in a 200. Code reads every non-200 as "not known" and starts nothing.
- Room: Code's room for a project's upkeep AI (the wiki refresh, repair drafts) is `limitMicros - spentMicros` from this one answer. Both numbers are exact (whole micro-dollars, the item and the meter row as stored) and read fresh on every call: nothing is cached between calls, so a spend or a changed limit shows in the very next read. Open holds are not in `spentMicros`.
- Steps: the gateway does not whitelist task-token steps on the agent route; the upkeep cap follows the token's `src: "nightly"` alone, so every upkeep step (the wiki refresh, Code's `repair_draft`, ...) is held to the same `upkeep_month` limit and counts in the same row.
- Scope of `enforced`: it covers calls on the agent route whose task token has `src: "nightly"` (`upkeep-cap.ts`). A call priced by estimate can settle slightly above the limit (the correction only sets `capExceeded`); Code reads `spentMicros >= limitMicros` as a pause.
- Needs no new IAM, secret or parameter: it reads the Companies and meter tables the serving role already reads for the agent route. It is mounted on every serving process, before the agent route's fallthrough. Rate limit as the other service reads (8 at once, 600 a minute per serving task).

### The contract for callers (Code's nightly jobs and answer services)

Names the callers build on (all in `packages/model-gateway/src`; nothing here changes without a new decision):

| What | Name | Where |
|---|---|---|
| Upkeep cap kind (spend-limit kind) | `upkeep_month`, scope project, `PUT /org/spend-limits/upkeep/<project>`, default $25, $0 = none | `company-store.ts` `SPEND_LIMIT_KINDS` |
| Work origin of upkeep AI | TC-1 claim `src: "nightly"` (the existing `WORK_ORIGINS` value; no new origin) | `model-gateway-token.ts`, `upkeep-cap.ts` `UPKEEP_ORIGIN` |
| How a nightly job reserves upkeep money | It does not call a reserve API. It makes its ordinary agent-route call (`POST /v1/messages`, task token) with a token minted with `src: "nightly"`; the gateway holds the project's upkeep row before the call (worst-case estimate), settles it after, and refuses before the key is read or anything is sent. A job that wants to avoid a refused call reads the project's limit and spent amount from Cloud (`GET /org/spend-limits`; spent: the meter's upkeep row) | `upkeep-cap.ts`, `server.ts` |
| Upkeep pause signal | HTTP 422, error type `upkeep_paused`, header `x-rovara-upkeep-pause` = `no_budget` (limit $0, none configured) / `monthly_limit` (used up until next month) / `cost_too_high` (one call larger than the whole limit); fixed words in `UPKEEP_PAUSE_MESSAGES`. An unreadable limit is 503 `unavailable`, not a pause | `upkeep-cap.ts` |
| Answers purpose | TC-1 token with `stp: "rovara-answers-call"` (`ANSWERS_STEP`), paths `/v1/answers/messages`, `/gemini/...`, `/vertex/...`, `/openai/chat/completions`; limit kind `answers_month` (scope company, id = the company id, default $20); refusals 422/403 `answers_paused` with `x-rovara-answers-pause` = `no_provider` / `monthly_limit` / `no_budget` / `cost_too_high`. A task step or a learning step is the fixed 401 there, and an answers token is the fixed 401 everywhere else | `answers-route.ts` |
| Answers cost header (L4-E2, DEC 254zzn) | Response header `x-rovara-cost-usd` (`ANSWERS_COST_HEADER`) on the answers route: the settled cost of THIS call in US dollars, a plain decimal with six places (whole micro-dollars, for example `0.006000`; Code parses it as a number and rounds up to cents). It is the amount the same settle wrote to the meter: the gateway settles first, then sends the head. Sent on a complete NON-streaming 2xx answer only (a streamed answer's head leaves before the cost exists, so call without `stream`), and only when the figure is exact. Absent, never `0` and never a guess, when the model's price is an estimate (unpriced model), the provider reported no usage, or the meter could not settle (the hold stays); a caller treats absent as "unknown" and keeps its own ceiling. Never on a refusal or provider error (`answers_paused`, 401, 4xx, 5xx), never on the agent or learning route, and never another company's figure, a running total or a limit: one call, one number | `answers-route.ts`, `server.ts` |
| Admin notice (NOT built; Cloud has no notification write path) | Proposed shape for Code to queue on seeing `upkeep_paused`: one attention event per (company, project, month, reason), kind `upkeep_paused`, to the project's admins and the company's owners and admins, fixed words (the `UPKEEP_PAUSE_MESSAGES` text plus the project name and a link to Spending limits), no amounts of other people, deduped by that key so a pause writes once. Delivery reuses Code's attention queue (`core/notify/attention.ts`), which is the existing inbox and Slack/email mechanism | Code (a follow-up row) |

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


## Missing-usage holds (DEC 254zzz69/70)

Receipt-bound token calls save the exact forwarded request byte count and the admitted price on the existing HOLD item. At cut-off, the existing CALL row records an `estimateStatus: estimated` amount E, while its receipt remains `awaiting_usage` and retains the original reservation R for compatibility. E remains reserved, rather than spent, and replaces R in committed cap exposure in the same conditional transaction.

The output estimate is nearest-rank p90 of the gateway's recorded, complete usage counts for that issuer, company, provider and model. Fewer than 20 samples keeps R (`estimateBasis: reservation`, `outputEstimateBasis: max_output`). Otherwise the input count is the provider's measured prompt total, including caches (`input_actual`), or the exact forwarded bytes (`input_bytes_bound`); a synthetic stream-start zero supplies no evidence. Both input and output use the dearest applicable reservation rates, and E is capped at R. The row records `outputEstimateBasis: p90_history`.

At 24 hours after cut-off, the bounded existing open-hold sweep atomically moves E from reserved to estimated spend, closes the hold and writes an immutable revision adjustment. Its receipt is `estimated`, reason `missing_usage`, with optional `neverConfirmed: true`; time never makes it final. Late real usage goes through the existing receipt revision transaction, using the saved original periods and E as the adjustment baseline. Concurrent late usage fences off the clock settlement through receipt revision and hold conditions.

The company-month meter row's optional `provisionalMicros` sums cut-off holds and settled, never-confirmed estimates. Clock settlement leaves that sum unchanged; real usage removes the call's provisional contribution once. The existing admin `GET /org/spend-limits` exposes this optional total through the existing exact-key BatchGet reader. A deployment without the reader or an older row without the counter omits it; an unreadable counter is omitted as unavailable while settings and overrides still read. No route, table, index or IAM grant is added. The canonical receipt schema and both repos’ strict readers accept the optional never-confirmed marker before production.

The previously deferred source/receipt coverage, authenticated gateway-to-Code delivery and historical backfill remain separate work; legacy adapters retain their existing behavior. Existing rows without the saved request context are not re-estimated by this change.

Round 4: missing-usage history reads one reverse CALL-key window of at most 200 rows, filtered to the same company, provider and model. A sparse window retains the full reservation; the reader never pages through the ledger. The provisional context stores the body size after OpenAI/Converse translation and the same 4,096-token tool allowance used for reservation (only the unknown-input bytes bound adds the allowance).
