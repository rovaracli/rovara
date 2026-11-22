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

Rules: admins only (reads too); the company's loosening rules only when a change raises the effective limit (removing an override raises it when the default is higher; no
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
Raising either above its default is a raise like any other (the company's loosening rules); lowering, even to $0, is not.

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
| Answers purpose | TC-1 token with `stp: "rovara-answers-call"` (`ANSWERS_STEP`), paths `/v1/answers/messages` (also `/v1/answers/v1/messages`, the path an Anthropic client builds from the base `<gateway>/v1/answers`: Rovara's Slack chat and message router, DEC 254zzz79 (3), counted in the same answers month), `/gemini/...`, `/vertex/...`, `/openai/chat/completions`; limit kind `answers_month` (scope company, id = the company id, default $20); refusals 422/403 `answers_paused` with `x-rovara-answers-pause` = `no_provider` / `monthly_limit` / `no_budget` / `cost_too_high`. A task step or a learning step is the fixed 401 there, and an answers token is the fixed 401 everywhere else | `answers-route.ts` |
| Answers cost header (L4-E2, DEC 254zzn) | Response header `x-rovara-cost-usd` (`ANSWERS_COST_HEADER`) on the answers route: the settled cost of THIS call in US dollars, a plain decimal with six places (whole micro-dollars, for example `0.006000`; Code parses it as a number and rounds up to cents). It is the amount the same settle wrote to the meter: the gateway settles first, then sends the head. Sent on a complete NON-streaming 2xx answer only (a streamed answer's head leaves before the cost exists, so call without `stream`), and only when the figure is exact. Absent, never `0` and never a guess, when the model's price is an estimate (unpriced model), the provider reported no usage, or the meter could not settle (the hold stays); a caller treats absent as "unknown" and keeps its own ceiling. Never on a refusal or provider error (`answers_paused`, 401, 4xx, 5xx), never on the agent or learning route, and never another company's figure, a running total or a limit: one call, one number | `answers-route.ts`, `server.ts` |
| Admin notice (NOT built; Cloud has no notification write path) | Proposed shape for Code to queue on seeing `upkeep_paused`: one attention event per (company, project, month, reason), kind `upkeep_paused`, to the project's admins and the company's owners and admins, fixed words (the `UPKEEP_PAUSE_MESSAGES` text plus the project name and a link to Spending limits), no amounts of other people, deduped by that key so a pause writes once. Delivery reuses Code's attention queue (`core/notify/attention.ts`), which is the existing inbox and Slack/email mechanism | Code (a follow-up row) |

## People and limits (cost report slice A6)

`GET /org/people-limits[?project=<name>]` (`packages/cloud-server/src/people-limits-routes.ts`) and the admin page `/app/admin/money/people` show each current member's spend this month against
the limit that applies to them (their own override, else the company default `memberMonthlyUsd`), by NAME only. Owner rule (decision D2): per-person SPEND against LIMITS, visible to company
owners and admins only; no quality or speed number, no ranking, no merged or task count per person. The row has five fields (`developerId`, `name`, `spentCents`, `limitCents`, `limitSource`), the
server sends no other, and Spending carries no per-person table any more.

- People: Code's company member list as the admin (current members; a row filed under another company refuses the whole answer). The project filter narrows WHICH people are listed (the people
  Code lists on that project, intersected with the company's members). The gateway's meter has one row per person and month, not per project, so a person's spend is always their whole company-month. The column says "Company spend this month"; selecting a project changes the roster, not the spend scope.
- Limits: the override items and `settings.budgets` above. An override list that is partial, or an item that is not exactly this company's person item, refuses the answer.
- Spend: the gateway's person-month meter rows (`CO#[issuer,company]` / `ROW#["person",<person>,"YYYY-MM"]`, `spentMicros`) through `PersonSpendReader` (`gateway-meter-read.ts`,
  `DynamoGatewayMeterReader`: read-only `BatchGetItem` of exact keys, consistent reads, every row checked against the asked company and person). Spend rounds UP to whole cents, a limit rounds DOWN.
  Before interpreting missing person rows as zero, the reader verifies the existing company-month row (`ROW#["company","YYYY-MM"]`) in that issuer/company partition. A missing or malformed company row refuses the read, including a new or unused monthly partition. A row that does not read refuses the whole answer; nobody is drawn as $0 for a number that could not be read.
  A row that does not read refuses the whole answer; nobody is drawn as $0 for a number that could not be read.
- Setting it on: `scripts/cloud-lambda.ts` builds the reader from `CLOUD_GATEWAY_METER_TABLE` (the gateway's meter table name; the issuer is `<ROVARA_CODE_URL>/v1/auth`). The issuer must equal the gateway's `GATEWAY_INSTALL_ISSUER` exactly (check it when switching this on: a mismatch would find no rows and show everyone as $0). The amounts count finished calls only (`spentMicros`), not money held for running work. Unset, the route answers 501 and the
  page says "not connected yet". `CloudWebStack` takes the gateway's **Meter** resource's physical table name as `GatewayMeterTableName` (not ProductMeter, LearningMeter or AnswersMeter),
  sets `CLOUD_GATEWAY_METER_TABLE`, and grants only `dynamodb:GetItem` and `dynamodb:BatchGetItem` on that table ARN. Both its identity policy and the boundary's added read statement require
  `ForAllValues:StringLike` `dynamodb:LeadingKeys` `["CO#*"]` and `Null` `dynamodb:LeadingKeys` `"false"`. The current reader sends only BatchGetItem. Before enabling, compare the gateway's
  `Issuer` output with the web stack's `CodeUrl` plus `/v1/auth`; no separate issuer variable is needed. The controller passes the table name as a parameter, as for the product key table, so the stacks remain independently deployable.
- The ordinary agent route meters a person only for a signed member payer, using that payer's developer id. For project, agent and chain payers the requester stays in the signed claims for audit and key lookup, without a person-month charge. Existing historical person charges are not rewritten.
- Changing a limit stays on Spending limits (B1): each row links to `/app/admin/money/limits?person=<id>`, which opens that person's add or edit form.


## Missing-usage holds (DEC 254zzz69/70)

Receipt-bound token calls save the exact forwarded request byte count and the admitted price on the existing HOLD item. At cut-off, the existing CALL row records an `estimateStatus: estimated` amount E, while its receipt remains `awaiting_usage` and retains the original reservation R for compatibility. E remains reserved, rather than spent, and replaces R in committed cap exposure in the same conditional transaction.

The output estimate is nearest-rank p90 of the gateway's recorded, complete usage counts for that issuer, company, provider and model. Fewer than 20 samples keeps R (`estimateBasis: reservation`, `outputEstimateBasis: max_output`). Otherwise the input count is the provider's measured prompt total, including caches (`input_actual`), or the exact forwarded bytes (`input_bytes_bound`); a synthetic stream-start zero supplies no evidence. Both input and output use the dearest applicable reservation rates, and E is capped at R. The row records `outputEstimateBasis: p90_history`.

At 24 hours after cut-off, the bounded existing open-hold sweep atomically moves E from reserved to estimated spend, closes the hold and writes an immutable revision adjustment. Its receipt is `estimated`, reason `missing_usage`, with optional `neverConfirmed: true`; time never makes it final. Late real usage goes through the existing receipt revision transaction, using the saved original periods and E as the adjustment baseline. Concurrent late usage fences off the clock settlement through receipt revision and hold conditions.

The company-month meter row's optional `provisionalMicros` sums cut-off holds and settled, never-confirmed estimates. Clock settlement leaves that sum unchanged; real usage removes the call's provisional contribution once. The existing admin `GET /org/spend-limits` exposes this optional total through the existing exact-key BatchGet reader. A deployment without the reader or an older row without the counter omits it; an unreadable counter is omitted as unavailable while settings and overrides still read. No route, table, index or IAM grant is added. The canonical receipt schema and both repos’ strict readers accept the optional never-confirmed marker before production.

The previously deferred source/receipt coverage, authenticated gateway-to-Code delivery and historical backfill remain separate work; legacy adapters retain their existing behavior. Existing rows without the saved request context are not re-estimated by this change.

Round 4: missing-usage history reads one reverse CALL-key window of at most 200 rows, filtered to the same company, provider and model. A sparse window retains the full reservation; the reader never pages through the ledger. The provisional context stores the body size after OpenAI/Converse translation and the same 4,096-token tool allowance used for reservation (only the unknown-input bytes bound adds the allowance).


Cloud's Spending page reads `GET /v1/app/org/spend`. Only current company owners and admins can read it; Code's fresh access check supplies the company, and request selectors are refused. The existing `DynamoGatewayMeterReader` reads exactly that company's current UTC company-month row with a consistent BatchGet. The response uses `spentThisMonthUsd`, `heldUsd`, the configured `limitUsd`, and `remainingUsd` (limit less the meter's committed total). Its optional `provisionalMicros` appears as “Not yet confirmed”; provisional is part of committed (spent or held). An older row without it stays unavailable. Missing rows, invalid totals, meter failures and a month rollover fail the read. This adds no meter writes, tables or IAM grants. AI and spending is the company monthly-limit editor; Spending limits holds project/person monthly limits, and project pages hold task limits.

## OpenRouter tariff exceptions

`OPENROUTER_RELAXED_TARIFF_MODELS` contains exactly `openai/gpt-5-mini` and
`openai/gpt-5-nano`. In the installed policy reader and legacy manual qualification,
only these IDs may default absent internal_reasoning,
request and input_cache_read prices to string `"0"`, or omit a well-formed
nonnegative catalog web_search price from the tariff. Their search exception
retains the explicit tool/plugin/suffix prohibitions. Every other ID requires
all six price fields and zero auxiliary prices, including web_search.
Unknown/conditional fees and explicit malformed values still refuse.

Mini/nano may normalize an **absent** cache-write price to `"0"` only with
`cacheWriteBasis: "never_requested_enforced"` and
`cacheWriteEnforcementVersion: "openrouter-no-cache-write-v1"` in the private
pinned-route tariff row. Both fields enter its hash. Missing/stale proof,
non-allowlisted models, and explicit malformed values refuse. Qualification
records this proof using the same request builder as runtime; it never silently
infers a zero fee from catalog absence. The builder recursively refuses cache
and prompt-caching parameters; the Anthropic translator strips cache_control.
Reported cache-write tokens survive response translation. Any positive count
refuses the answer (destroys an active stream), retains max(hold, known debit,
valid token cost) provisionally, and latches the existing durable source stop,
even below the hold. This is a conditional enforcement basis, not a claim about
future provider billing. Qualification also refuses reported writes and positive
auxiliary charges. Reviewed live route evidence and installation are still
required; `REVIEWED_OPENROUTER_POLICIES` remains empty.

The hold remains rounded upward to micro-USD:

`promptBound * (max(prompt, input_cache_read) + input_cache_write) + max_tokens * max(completion, internal_reasoning) + request`.

Every possible prompt token gets the higher prompt/cache-read rate plus the
explicit write fee. The direct builder refuses caching directives recursively;
the Anthropic translator strips cache_control markers. Plugins, search options,
server search tools and routing/free suffixes refuse. The gateway still refuses
`:thinking` and tilde IDs until the GATEWAY-FOLLOWUP lane lands; qualification
first requires an exact catalogue entry. This boundary covers the company
OpenRouter-key route and qualification, not custom-endpoint transport.

Qualification refuses positive or unreadable reported auxiliary cost/fee/search/
cache-write evidence, including documented prompt_tokens_details.cache_write_tokens.
It retains validated cache counts and fixed PASS/FAIL checks without echoing
arbitrary upstream fields. Only upstream_inference_cost may appear in cost_details;
usage.cost must equal that inference total and generation.total_cost exactly.
Under DEC 254zzz330 the inference total must be positive and no greater than the
dearer token interpretation: uncached prompt at prompt rate, cached prompt at
cache-read rate, completion plus reasoning at completion rate, plus request.
Each receipt's counts must be readable; the larger token maximum across usage
and generation is retained. Counts need not agree across the two receipts.
In all-models qualification that token maximum must also fit the original hold:
`reported <= token maximum <= hold`. A reported charge above the token maximum
is `hidden_charge`: FAIL, no candidate, original hold and any higher debit retained,
and all remaining calls/providers for that model stopped. Overall-cap excess stops
the run; other models may continue below the overall cap. Unexpectedly accepted
price-cap probes use the same backstop and model stop. Unreadable receipts refuse
and retain their holds.

The legacy report check no_web_search_cost means no **reported** auxiliary charge
and bounded token-only reconciliation; it is not an itemized zero-search receipt or
proof about later calls. Offline tests cannot establish real route billing,
max_price enforcement or reasoning/output limits. Sol re-review, lead 4 Opus money
review, 9d's final stamped gate, real pinned-provider qualification and installed
staging proof remain required before a tariff is approved and installed.


### Run-8 candidate review queue

The private tariff source is `packages/model-gateway/src/openrouter-policy.ts`.
Its `CANDIDATE_OPENROUTER_POLICIES` records the two proposed rows from
`briefs/codex/providers-fast/M2-LIVE-REPORT-run8.json` (owner run 8, `ef670ae9b`).
Each row carries `status: "CANDIDATE"` and the report pointer. These are review
inputs only: the runtime default is still the empty `REVIEWED_OPENROUTER_POLICIES`,
and the policy reader refuses labelled rows even when explicitly supplied.

Promotion uses the existing reviewed source path: reviewers approve the evidence
and exact route/rates/restrictions, then a source edit removes the candidate label
and places the approved row in `REVIEWED_OPENROUTER_POLICIES`. The original
24-hour freshness rule still applies; an expired candidate needs renewed evidence,
never a fabricated timestamp. There is no automatic import, promotion or install.
9d's final gate, money reviews and installed staging proof remain required.
OpenRouter stays off by default until the owner's launch decision (DEC 254zzz337).

Run 8's four cap probes all returned HTTP 404 with error code `"404"` and
`"No endpoints found that satisfy the max price for this request"`. Qualification
now accepts only that message (case-insensitive, surrounding whitespace and one
optional trailing period). The successful same-run control, one-component cap
differential, accepted 400/404/422 statuses, zero debit and absent id/usage guards
remain in force; generic no-endpoint/data-policy errors cannot qualify a tariff.

### Catalogue-wide qualification (DEC 254zzz338)

The owner should first run a discovery dry run with a one-micro-dollar cap:

```sh
node scripts/openrouter-qualify.mjs --all-models --report discovery-report.json --spend-cap 0.000001 --per-model-cap 0.05
```

The intent is free catalogue/endpoint lookups only: a first paid hold above
one micro-dollar refuses before sending. Inspect the exclusions and
`failuresByCause` before the $15 run, and confirm `reservedMicros` and
`chargedMicros` are zero. Real endpoint data may exclude every route, for
example through extra pricing keys that the bounded schema refuses. This cap
is not a no-send mode: a one-micro-dollar hold can fit. A FAIL exit is expected
when the cap refuses or all routes are excluded.

After checking discovery, the owner can run the same harness across the catalogue:

```sh
node scripts/openrouter-qualify.mjs --all-models --report report.json --spend-cap 15.00 --per-model-cap 0.05
node scripts/openrouter-qualify.mjs --all-models --report next-report.json --spend-cap 15.00 --per-model-cap 0.05 --resume report.json
```

Every all-models CLI run saves its report (default `report.json`) and the raw
fetched JSON next to it (`discovery-report-catalogue.json` in the discovery
example). The snapshot has `models` (the entire model-list body) and `endpoints`
(each fetched endpoint body, indexed by exact model ID). Non-success JSON bodies
are retained too, with their HTTP codes in `statuses`, indexed by request path.
No request metadata or headers are saved. A credential echo, including a
16-character key fragment, or Authorization data withholds both files. The report
is still printed to stdout on ordinary runs; `--report` names the files explicitly
because shell stdout redirection does not tell the harness its destination.

Offline eligibility replay can supply the parsed snapshot to the module's
`qualify({ allModels: true, catalogue, ... })` input, using the same caps as the
discovery and an injected `fetch` that throws to prevent paid calls. Supplied
catalogue lookups never fall back to the network when an endpoint body is missing.
This replays discovery verdicts; it does not replace live qualification evidence.

The key still comes only from the harness process's `OPENROUTER_API_KEY`.
`--all-models` cannot be combined with manual model/provider selection. The
catalogue and each provider endpoint must declare tools support and satisfy a
bounded tariff. Provider endpoint prices are checked independently; aggregate
catalogue prices never replace a missing endpoint tariff. Estimated, ambiguous,
unpriced and unsupported routes are excluded with reasons. Eligible routes retain
the run-8 identity, BYOK and price-cap refusal checks plus the DEC 330 backstop.

All-models qualification normalizes **absent** components individually:

- `request` and `input_cache_read` are zero when absent.
- Absent `internal_reasoning` uses the completion price, never zero. Its hold
  adds `reasoning.max_tokens * completion` outside the ordinary output reservation,
  rounded upward, so output exposure includes at least
  `(max_tokens + reasoning.max_tokens) * completion`.
- Absent `input_cache_write` is zero only because no cache-write directives are
  sent. The existing unexpected-write refusal remains mandatory.

Explicit null, negative or malformed prices still refuse. Prompt/completion must
be present and positive. Each CANDIDATE row records `assumedZero` (only the absent
components actually normalized to zero) and, when applicable,
`reasoningBilledAtCompletion: true`. These are qualification report annotations,
not an installed tariff or a change to runtime absence defaults. Promotion must
review the extra qualification reservation and request restrictions; the runtime
policy reader's legacy absent-price rules remain above.

`pricing.overrides` is parsed as flat price patches with recognized conditions:
`min_prompt_tokens`, `context_length`, UTC `utc_start`/`utc_end` (HHMM, paired),
and `utc_days` (weekday names). Every component uses the maximum across the base
and **every** override, regardless of the current context, day or time. Unknown
shapes, unknown keys or malformed conditions exclude the route with a reason.
Known unused prices in overrides are checked too.

Nonzero `web_search`, image/audio (`image`, `audio`, `input_audio`, `output_audio`,
`input_audio_cache`) and `input_cache_write_1h` prices are allowed only because
every outgoing qualification body contains plain text and no plugins, web/search,
media or cache controls. Receipt checks still reject auxiliary charges, including
native search that occurs without a requested plugin. An unknown price key always
excludes and is named in the diagnostic. `:online` and `:free` remain excluded;
free variants have a different data policy. Exact `:thinking` and tilde catalogue
IDs are allowed without alias inference. Rejected public IDs are logged raw with
the reason; credential echoes remain redacted.

This extended ID support is harness-only. CANDIDATE rows containing `~` or
`:thinking` are **not promotable** until a separate gateway lane, with its own
Opus review, widens `packages/model-gateway/src/openrouter-policy.ts`. The runtime
validator remains unchanged; the deferred patch is in the lane's
`briefs/codex/providers-fast/GATEWAY-FOLLOWUP.md`. OpenRouter stays off by default
pending the owner's launch decision (DEC 337).

Offline proof uses the owner's `ALL-MODELS-DISCOVERY.json` rejection report and
the supplied raw catalogue fixture. Of its 441 rows, the 343 named IDs can be
matched exactly: 264 now clear catalogue eligibility, 58 lack tools and 21 still
have specific tariff/output exclusions. The other 98 IDs were already redacted
by the old report and cannot be recovered. Provider endpoint data and real route
billing remain unproven offline. `ABSENT-ZERO-COUNTS.md` in the providers-fast
brief folder records the full count table and these limits.

The default overall cap is $15 and the default per-model cap is $0.05. Each paid
call, including each refusal probe, reserves its full hold against both caps.
Holds remain exposed even when a receipt fails; any higher observed debit is
also retained. The model cap spans all of that model's provider routes. A model
cap abandons that model and permits the next; an overall cap or shared
authentication/credential stop prevents further paid calls. `notReached` lists
models that received no paid attempt because of those stops. Actual charges,
reserved holds and conservative exposure are separate report fields.

A model passes when at least one eligible provider route passes; failed and
excluded providers retain their own evidence. `failuresByCause` groups failed
models by cause, counting a model once per cause. A cap-abandoned model fails.
Only passing models' passing routes enter `proposedTariffRows`, labelled
`CANDIDATE`. No report modifies the reviewed tariff source or installs prices.

Resume skips a prior PASS only when its current eligible tariffs and pinned
provider identities match and the harness/policy/token-validation implementation hash is
unchanged. It carries the prior evidence and candidate rows, without refreshing
their timestamps or counting prior-run charges against the new run's caps.
Changed/failed models run again; unqualified extra resume rows are not carried.
Use a new output filename when resuming so shell redirection cannot truncate the
input report. Batch money review, tariff promotion and staging proof remain
separate owner/controller steps.
