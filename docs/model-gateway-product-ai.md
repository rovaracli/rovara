# Model gateway: the product-AI route

Plan v3.2 row 20.2 (the Gemini journey), section 7.4 item 7; DEC 157, 165, 172, 214 #18, 216, 217.
Code: `packages/model-gateway/src/product-*.ts`. `startServe` mounts it when given `product` (resolver, its own meter on
separate tables, its caps); the deployed process builds it from its settings (`GATEWAY_PRODUCT_*`, see "Deployed"), off
when they are absent.

With the runtime from #53: the product route reads the company backend's budgets (`CompanyBudgetCaps`, fail closed: a
company with no monthly cap or an unreadable row gets no product calls; the monthly cap also bounds the product meter's
company row, with the product ceiling), takes each Gemini model's own output ceiling from the price rows
(`productModelLimitsFrom(prices)`; no row: 65,536), and its open holds, expiry and corrections run in the same
maintenance pass as the agent meter's (`sweepOpenHolds` on the product meter). The company backend's monthly cap is
applied ONCE to agent and product spend together (DEC 228c, below).

## What it is

A second route on the same gateway for calls made by the customer's **tests** with the project's **own** AI key.

| | Agent route (`POST /v1/messages`) | Product route (`POST /v1/product/gemini/...`) |
|---|---|---|
| Token | TC-1 task token | the same token (key purpose `task`) |
| Key | the gateway's provider key | the project's product key (write-only store) |
| Meter | agent meter | its own meter (separate table or key prefix) |
| Caps | task, person, project, company | product caps: task and project month, clamped by the company ceiling |
| Who pays | the token's payer items | the project, always (no person item) |
| Price | `resolvePrice` (live prices, R3c) | the same resolver, provider `gemini` |
| Models | only the token's `mdl` | any Gemini model id (DEC 172: no model is refused for price) |

The money core (worst-case hold, settle once in `finally`, not-sent faults free, post-send faults charged in full, the
one-overrun-call-per-company marker, deadlines, the secret scanner) is shared code in `server.ts`: both routes are
`GatewayRoute` adapters.

## Product key store (`product-keys.ts`, `product-seal.ts`)

- Per project (`owner` = project name) and per company (`owner` = `_company`). A project uses a company source by a
  **link**, never a copy, so removing the company source stops it for every linked project in one transaction. A link
  names the source's connect time, so a source id re-used after its window is a different source.
- Keys are sealed with envelope encryption (KMS data key, AES-256-GCM), bound to install, company, owner, source and
  version through the KMS encryption context and the GCM additional data. KMS purpose `rovara-product-ai-key`.
- Every key-row read names `AWSCURRENT`; rotation demotes the old version to `AWSPREVIOUS` (purged after 7 days);
  removal schedules deletion with a 7-day recovery window; a source id in its window can be recovered but not re-added.
- Each change: request id + expected revision; a replayed request id with the same keyed-HMAC intent fingerprint is
  idempotent, a different intent is refused. The seal runs before ONE transaction (document, key rows, receipt, audit
  row), so there is never pending work to abandon.
- Roles: a company admin or a project maintainer may change a project's key and caps; company sources and the ceiling
  are admin-only. The caller (Cloud's settings route, later) checks the role with Code.
- Defaults (DEC 157): $2 per task, $50 per project month.

## Gemini

- Paths: `/v1/product/gemini/{v1|v1beta}/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`.
  No other query (a `key=` is refused); a leftover `x-goog-api-key` is refused (the worker must have replaced it).
- The gateway always sets `generationConfig.maxOutputTokens` (the row's max when absent; 65,536 for an unknown model).
- Refused: server tools (search grounding, code execution, URL context), media with no declared type, non-text output
  (audio output too: its price is in the snapshot, but `maxOutputTokens` bounding for speech answers is unverified),
  `candidateCount` above 1, and audio or video sent by file reference (`fileData`: the request names no size or length,
  so nothing can be held before the call; Google's `files.get` reports both, a possible follow-up). Images, PDFs and
  text files are allowed; any media part, `cachedContent` or `fileData` makes the call overrun-capable (media is billed
  per item, not per body byte; DEC 165, ADDENDUM-3).
- Audio and video input (DEC 228e), inline only. Prices come from the same LiteLLM rows (`media-price.ts`, snapshot
  `sources.litellm.media`, `SnapshotPriceSource.mediaFor`, passed to the route as `media`): a listed
  `input_cost_per_audio_token` / `input_cost_per_video_token` (dearest of standard, batch, flex). A row that lists the
  modality as supported but gives no media price is held and settled at 3x the text input rate (3x the cache-read rate
  when cached; Google's highest media multiple today), never below the text rate, and flagged estimated with a
  correction row of the media counts, so a correction re-prices it once the row lists a price (controller decision,
  logged for owner review). A per-second price, an explicit `supports_<m>_input: false`, a zero or
  malformed price, or no row leaves it unpriced and the call is refused (never $0, DEC 172). Video needs the audio price
  too (its audio track). The hold replaces the media's base64 bytes with an estimate: audio 32 tokens a second at a
  6 kbit/s floor; video (fps x 300 + 32) tokens a second over the declared clip (`videoMetadata` offsets) or a 16 kbit/s
  floor; capped at 2,097,152 tokens; every input token held at the dearest usable rate. Very compressible media can cost
  more than that, so media calls stay overrun-capable (one per company at a time; the cap is passed by at most one call).
- Usage: `cachedContentTokenCount` at the cache-read rate, the rest of the prompt plus `toolUsePromptTokenCount` at
  input, `candidatesTokenCount + thoughtsTokenCount` at output. AUDIO and VIDEO tokens from `promptTokensDetails` and
  `cacheTokensDetails` are charged at their own rates (a listed rate never below the tier's text rate; cached audio at
  its listed cache rate). A media call whose answer has no details bills the whole prompt as its dearest media kind;
  reported audio/video with no price (a cached context holding audio, a model with no media row) is charged at 4x the
  text input rate, never below the hold, flagged estimated (a correction row) and over the hold an over-reservation
  (DEC 165). A long-context media tier in a row leaves that modality unpriced. The deployed process must build the route with
  `media: prices` (the `SnapshotPriceSource`); without it audio and video are refused. An estimated price writes the
  correction row with the media counts, and corrections re-price them with the current media rates (none: left for an
  operator, never re-priced as text). A finish (`finishReason` or `blockReason`) is required;
  otherwise the call settles at its full hold. Media is found at any depth of the contents (for example
  `functionResponse.parts`) and in both spellings Google accepts (`inlineData`/`inline_data`, `mimeType`/`mime_type`);
  a top-level part may carry only known part fields.
- Provider 400/401/403/404/429 are explicit rejections before any generation and cost nothing; 401/403 answer
  "not run: the product key was refused (check it in Settings)" and mark the source for the settings page.
- DEC 165: when a product call settles above its hold, every later product call in that task gets
  "budget exceeded by one call".

## Vertex AI (DEC 229b; `product-vertex*.ts`)

The pilot may call Gemini through AI Studio or through Vertex AI, so both are served. Vertex runs under the same money core as
Gemini: the same body guard, media rules, output ceilings, usage reading, combined company cap, eval stage holds and outcome
classes (`product-vertex.ts` wraps `guardGemini`).

- Paths: `/v1/product/vertex/{v1|v1beta1}/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`
  and `:streamGenerateContent?alt=sse`. Google's own models only. The project and location must be the CONNECTED ones: another
  is `400 not_allowed` ("this Google Cloud project or location is not the one connected for product AI") before any hold,
  token or send, even if the token could reach it. The upstream path is built from the key store, never from the request;
  the host is `{location}-aiplatform.googleapis.com` (`aiplatform.googleapis.com` for `global`). Multi-region locations
  (`us`, `eu`, `*.rep.googleapis.com`) are not offered.
- Eval stages (L4-EVV): Code's eval worker does not know the connected project and location, so its sandbox client is given Rovara's
  placeholder pair (`EVAL_VERTEX_PLACEHOLDER`: project `rovara-eval-project`, location `rovara-eval1`; the same two words are Code's
  `EVAL_VERTEX_PLACEHOLDER`). A Vertex call that carries a found eval stage's scope (`x-rovara-eval-scope`: this company, project and
  task) and names exactly that pair is read as the connected one; the upstream path is built from the key store as always (the
  placeholder never leaves). Any other pair, a half-pair, and the same pair with no scope or an unknown, another company's or another
  task's scope keep the `400 not_allowed` / not-found answers above, before any hold, token or send. The stage's count, held cost,
  caps, meter rows and release are the Gemini stage's (the eval hold already accepts a Vertex connection). Code names the row with
  `catalogRowId = "vertex"` in the confirmed eval plan, so the owner's spend approval names Vertex.
- Refused from the caller: `x-goog-api-key`, `x-goog-user-project`, `x-goog-iam-*`, `x-goog-authenticated-*`; a Google bearer
  next to the task token is ambiguous (401). A cached context must be `projects/<connected>/locations/<connected>/cachedContents/...`.
- Prices (coordinator decision on review L1): a Vertex call is priced at the DEARER of the AI Studio row and the Vertex row
  of the same model, per component and per long-context band (`GatewayRoute.alsoPricedAs`, `dearerPrice`; LiteLLM keys
  Vertex rows bare or as `vertex_ai/<model>`, both are read). A row that is only an estimate adds nothing; a model with only
  a Vertex row is priced on it; with neither, the cautious estimate (DEC 172), never $0. Checked 2026-11-15: the text models'
  rows are equal; some image models list dearer Vertex-only rates, which this now charges. Audio and video rates still come
  from the Gemini media rows (equal today); logs and corrections name provider `gemini`.
- Credentials (`product-vertex-credential.ts`), connected as provider `vertex` in the key store (JSON `key`):
  - `{"scheme":"federation","projectId","location","audience","serviceAccount"?}` (preferred, nothing secret stored): the
    gateway assumes Rovara's federation role with **RoleSessionName = the company id** (`org_` + 20 characters, within AWS's
    2-64 character rule), signs (never sends) an AWS `GetCallerIdentity` request with that session as the subject token,
    exchanges it at `sts.googleapis.com/v1/token`, and, when a service account is named, at
    `iamcredentials.googleapis.com ...:generateAccessToken`. The customer's pool condition names the company's exact session
    ARN, so company A pasting company B's pool is refused by B's condition.
  - `{"scheme":"service_account_key","location","projectId"?,"keyFile"}` (fallback): the key file is checked (RSA, 2048 bits or
    more, `token_uri` only `https://oauth2.googleapis.com/token`), reduced to the fields the token flow needs and sealed like
    an AI Studio key; the gateway signs an RS256 JWT and exchanges it at `oauth2.googleapis.com/token`.
  - The settings view shows a summary (`vertex: {scheme, projectId, location, serviceAccount?}`), never the key.
- Connection test (`VertexTokens.probe`, the store's `vertexCheck`): before a Vertex credential is sealed (connect or rotate),
  a real token must be minted; for federation, a token exchange as a random canary company must be REFUSED by the pool. A pool
  that lets it through is `too_open` ("This Google setup would trust any Rovara company...") and nothing is saved. A store
  built without `vertexCheck` can't connect Vertex (fail closed).
- Tokens (`product-vertex-token.ts`): minted at admission (before the hold: a refused credential answers the key-refused words,
  free, and marks the source; an outage is 503), cached per key row (install, company, owner, source, version) until 5 minutes
  before expiry; AWS sessions per company the same way; a Vertex 401/403 drops the cached token. Token hosts are fixed
  (`sts.googleapis.com`, `iamcredentials.googleapis.com`, `oauth2.googleapis.com`, `sts.<region>.amazonaws.com`), TLS on 443,
  one attempt, no redirects, 5 s, 64 KiB. DEC 174: token hosts are not model hosts; model hosts are reached only through this
  metered route.
- Setup steps for the customer: `vertexSetupSteps({ awsAccountId, roleName, cid })` (structured steps and the condition string
  with the company's own ARN).
- Bridge: `contracts/shared/model-gateway-product-vertex.v1.json` (`PRODUCT_VERTEX_BRIDGE`), a file of its own so the Gemini
  contract and Code's pinned copy are unchanged.

Deployment (not built here): the federation role (`VertexTokensOptions.federationRoleArn`) needs no permissions; its trust
policy lets only the gateway's runtime role assume it, with `sts:RoleSessionName` like `org_*`; the runtime role needs
`sts:AssumeRole` on it; egress to the four token hosts and the Vertex hosts. Simulate against the permissions boundary before
any deploy.

## Engine bridge (`contracts/shared/model-gateway-product-ai.v1.json`)

The worker's trusted part sits between the sandbox and the gateway. The sandbox's test calls the worker's local port
with a dummy Google key; the worker removes Google credential headers and any `key=` query, adds the task token it
already holds (`GET /v1/internal/model-access`, Code #670) as `x-api-key`, and forwards to `<baseUrl>/v1/product/...`.
The file lists paths, headers, and every refusal (status, type, fixed words). Code's worker copies it byte for byte
(SHA-256 pinned in a test).

## Deployed (B5, B6, B8, B7, #57, #58)

Off unless configured. `-c rovaraModelGateway=<env> -c rovaraModelGatewayProductAi=on` adds to the gateway stack (without the
switch the template is byte for byte what it was; `tests/contract/model-gateway-product-infra.test.ts`):

- Tables (on-demand, point-in-time recovery, deletion protection, retained, company keys `CO#[iss,cid]`): `ProductKeys` (the key
  store, eval approvals and budgets; TTL `expiresAt` purges key rows and receipts), `ProductMeter`/`ProductLedger`/`ProductMarkers`
  and `LearningMeter`/`LearningLedger`/`LearningMarkers` (each meter its own tables, combined with the agent meter's company row
  and in-flight marker in code, DEC 228c), `EvalStages` (B8, below).
- KMS `ProductKeysKey`: `kms:Decrypt` only for the serving role, `kms:GenerateDataKey` only for Cloud's server role (parameter
  `CloudSettingsRoleArn`), both only for a sealed row of this install (`purpose` = `rovara-product-ai-key`, `install` = the
  issuer, exactly the six context keys). Nobody may `Encrypt`; the account manages but does not use it (as the provider-keys
  key). KMS `ProductKeysMacKey` (HMAC_256): `kms:GenerateMac` only for Cloud's server role (keyed fingerprints, F1-d L4).
  Because the key policy names each principal, `productKeyDenyStatement` is not needed on other roles for this key.
- The serving role: `GetItem`/`PutItem` on `ProductKeys` (read keys, record a refused-key warning), the agent meter's
  actions on the product and learning meter tables (`DeleteItem` on their markers only), `GetItem`/`PutItem` on
  `EvalStages`, `Query` on the seven named indexes, `kms:Decrypt` on the product key key, `sts:AssumeRole` on the Vertex
  federation role with an `org_*` session name.
- `VertexFederationRole`: no permissions; its trust names only the serving role, session name `org_*`, one hour.
- Environment: `GATEWAY_PRODUCT_KEYS_TABLE`, `GATEWAY_PRODUCT_KEYS_KEY`, `GATEWAY_PRODUCT_METER_TABLE`,
  `GATEWAY_PRODUCT_LEDGER_TABLE`, `GATEWAY_PRODUCT_MARKERS_TABLE`, `GATEWAY_EVAL_STAGES_TABLE` (all six or none),
  `GATEWAY_VERTEX_FEDERATION_ROLE` (optional), `GATEWAY_LEARNING_*_TABLE` (all three or none, only with the product route).
  `process.ts` builds the store (`DynamoProductKeyTable`, `awsKms`), the product meter, the eval stages on the shared table with
  the production approvals and budget (`eval-approvals.ts`), DynamoDB overrun marks, Gemini, Vertex (`VertexTokens`) and media
  prices (`media: prices`), and the learning route (`learning-keys.ts`).

Cloud's side (`-c rovaraCloudApp=<env> -c rovaraModelGatewayProductAi=on`, refused for `production`): parameters
`ProductKeysTableName`, `ProductKeysKeyArn`, `ProductKeysMacKeyArn`; the server role gets `GetItem`/`PutItem`/`UpdateItem`/
`ConditionCheckItem` on that table by company keys, `kms:GenerateDataKey` (same purpose and install condition) and
`kms:GenerateMac`; output `ServerRoleArn`; optional parameter `ModelGatewayUrl` (default empty: no Vertex connect from Cloud).
The release pipeline carries each environment's switches from `CLOUD_PIPELINE_SWITCHES` (`infra/lib/cloud-release-pipeline.ts`):
staging deploys with `-c rovaraModelGatewayProductAi=on`, production never (refused); a contract test pins both.

Settings routes (B7, `packages/cloud-server/src/product-ai-routes.ts`; screen: admin area, AI and connections, Product AI
keys): `GET /v1/app/projects/:name/product-ai`, `PUT|DELETE .../key`, `PUT .../eval-budget`, `PUT .../eval-approval`. The
project's admin or a company admin (Code's access check, made on every request), a fresh step-up on every write, the signed
write path (CSRF, body hash), Cloud audit records (`product_ai.*`). The key is write-only: no answer, log or audit carries it.
`PUT|DELETE .../vertex` (PRODUCT-VERTEX-CLOUD-CONNECT) takes a Vertex AI federation setup (Google Cloud project, location,
workload identity provider, optional service account): the store's `vertexCheck` asks the gateway to run the connection test
(`POST /v1/service/vertex-check`, `service-call.ts`: a token for THIS company, and a canary company refused), and seals only on
`ok`. The call is signed with the product key store's HMAC key: Cloud may only `GenerateMac`, the gateway's serving role may
only `VerifyMac` (key policy statement `OnlyGatewayVerifiesCalls`, role statement `VerifyCloudCalls`, env
`GATEWAY_PRODUCT_MAC_KEY`); the MAC covers its own purpose (never a key fingerprint's), the path, the time (60 s either side)
and the body's SHA-256. The gateway stays read-only on keys; a replay inside the window only re-runs the same test. The path is
on the public load balancer, so each serving task takes at most 2 checks at once and 30 a minute before any KMS call (429
otherwise): anonymous traffic never becomes unbounded KMS or Google calls.

Eval approvals (PRODUCT-EVAL-APPROVER-REREAD): an approval counts at the stage hold for 15 minutes (`EVAL_APPROVAL_FRESH_MS`)
from the moment the settings route began its role check with Code; older, the hold answers `422 eval_approval_stale` ("approve
it again"). Before Cloud changes a person's membership or role (project member added or removed, invite accepted), it
withdraws every approval that person made (`ProductKeyStore.withdrawApprovals`: one conditional write on the company's
withdrawal row, read with the approval at every hold); if that write fails the change is not made (503). Only someone who may
make the change withdraws anything (a project member change needs the project's admin or a company admin, checked with Code
first; refused otherwise, with nothing withdrawn); after Code made the change Cloud withdraws again (an approval whose role
check raced the change) and records `product_ai.eval_approvals.withdrawn_for_member`. While product AI settings are on, a
project member change must name the person by their 64-hex member id (anything else: 400). Code's own member
changes reach Cloud through no event today: for those, the 15 minutes bound the window. The settings page shows each approval's
state (`current`, `stale`, `withdrawn`).

Deploy order: read the Cloud server function's role ARN from the deployed Cloud web stack (its `Server` function's role; the
stack outputs it as `ServerRoleArn` once switched on), deploy the gateway with the switch and `CloudSettingsRoleArn`, then
Cloud web with the switch and the gateway's three outputs as parameters. The gateway stack's roles are
root-path roles without a permission boundary, which the agentx deploy role may not create: the gateway deploys with the CDK
bootstrap execution role (as before this change; the offline simulation in the infra test records it).

Other conditions (not enforced in code):
- The sandbox never holds the task token (Code's worker; plan 7.4 gap c).

## One combined company monthly cap (DEC 228c)

The company backend's monthly cap bounds agent and product spend TOGETHER. The product meter is combined with the agent
meter (`DynamoMeterOptions.combinedCompany: { meter, markers }` naming the agent meter's tables; `InMemoryMeter` option
`combineCompanyWith`): every product hold, settle, sweep and correction also moves the agent meter's company row
(`CO#[iss,cid] / ROW#["company",<month>]` in the agent meter table) in the same conditional transaction as its own rows,
judged against `Caps.combinedCompanyMonth` (the company backend's monthly cap; the product meter's own company row keeps
the product ceiling). Agent admission reads that row as it always did, so it sees agent plus product spend, settled plus
held. The company's one overrun-capable call in flight is the agent markers table's INFLIGHT item for both routes, so the
two routes together pass the cap by at most one call (DEC 165); a product settle past the cap marks the shared row, which
stops the agent route too. Fail closed: a combined meter given no combined cap holds nothing (503); a product route whose
meter is not combined answers 503 and sends nothing; `startServe` refuses to start with such a meter, or with a product
DynamoMeter combined with tables other than its own agent meter's.

## Whole-stage eval holds (Code #683, `EvalModelAccess.hold`; `product-eval.ts`)

All three requests carry the TC-1 task token; `createProductRoutes({ ..., evalStages: new ProductEvalStages({ approvals }) })`
mounts them.

| Request | Body | Answer |
|---|---|---|
| `POST /v1/product/eval/hold` | `{grant, calls, costMicros}` (`grant` is Code's `EvalSpendGrant`, every field checked at runtime) | `200 {scope, calls, costMicros, expiresAt}`; a refusal holds nothing (`422 eval_hold_refused` / `budget_exceeded`, `429 budget_held` / `busy`, `503 unavailable`, `404 not_set_up`) |
| `POST /v1/product/gemini/...` with `x-rovara-eval-scope: <scope>` | the ordinary Gemini call | `200 application/x-ndjson`: exactly one `{"kind":"head",status,headers}`, any `{"kind":"chunk","b64"}`, exactly one `{"kind":"settle",status,class,refusal?,costMicros,estimated,overrun?}` |
| `POST /v1/product/eval/release` | `{scope, calls, costMicros, unknown}` | `200 {released}` once; `409` after; `404` for any scope not the caller's |

- **Hold**: the grant must name the token's company and project and equal the project's approved eval spend
  (`EvalApprovalSource.current`: selection, inputs digest, confirmed call and cost ceilings; a recorded approval that no longer
  counts, too old or withdrawn, is `422 eval_approval_stale`); the approver's CURRENT role is
  re-read (`roleOf`: owner, admin or maintainer); the product key connection is re-read; `calls`/`costMicros` must fit the
  grant and the approved project eval budget (DEC 203 default 400 calls and $4, `budget` option per project); a task blocked
  by an overrun is refused. Then ONE meter reservation of the whole cost on the product meter: the stage's own task row
  (`tid` `eval.<scope>`, cap = the held cost; the per-task product cap governs ordinary product calls only), the project month
  row, the product-ceiling row and the combined company row. The scope is random, bound to install, company, project and
  task; any other caller gets the same `not found` as a missing scope.
- **Calls**: reserve nothing new on the meter. Refused (`cap`) once the stage is released, stopped or expired, at its held call
  count, or once its spend reached the held cost. A call whose hold fits (spend + open calls' holds + its own, and bounded by
  its price) runs in parallel; one that may pass the held cost (does not fit, or is overrun-capable) waits (at most 2
  minutes) and runs ALONE, so a stage passes its hold by at most one call; that call's settle carries `overrun: true`, and
  the stage and the task's product calls stop (DEC 165).
- **Classes**: `ok` only for a complete answer; `rate_limit` (429 per minute or unmarked), `quota` (429 whose words say a daily
  or billing quota), `overloaded` (429 saying overloaded, 503, 529), `cap` (any budget refusal), `key_refused` (401/403),
  `provider_error` (other provider failures, a cut-off or malformed answer), `refused` (our other refusals). The ordinary
  product route answers the same split with codes `provider_limited`, `provider_quota`, `provider_overloaded`.
- **Release** (once): the parent hold is settled exactly once, and only when no call of the stage is open, at the gateway's
  own stage spend (a caller's higher report is charged only up to the hold). `unknown: true`, or a call still open at the
  release, keeps at least the whole hold spent; a call still open settles the parent when it ends, so its real cost (past
  the hold too) is counted. The call that passes the hold keeps the company's in-flight marker until the parent (its
  overshoot) is on the meter; the stage then settles at once, without waiting for a release. A release is taken after the
  task ended (it only gives budget back). A failed settle answers 503 and can be retried; the maintenance pass retries too.
- **Expiry and sweep**: a stage lives 4 hours (`EVAL_STAGE_MS`); the maintenance pass (`startServe` `product.stages`) stops
  expired stages and settles them at their counted spend (whole hold if a call is still open, settled when it ends). The
  parent hold asks the meter's open-hold sweep to wait until the stage's end (`ReserveInput.sweepAfter`, stored as
  `openFrom`), after which a hold whose process died is closed at its whole estimate as usual. The open-stage limits (8 per
  company, 2,000 overall) count a slot before any await.
- **Shared by every gateway task** (B8): stages live in the `EvalStages` table (`dynamo-eval-stages.ts`), so a hold, its calls
  and its release may each reach a different task. Every change is a conditional write on the stage's version, retried from a
  fresh read on a lost race; money moves on the meter outside those writes, ordered so a task dying between steps leaves the
  hold to the sweep at its whole estimate. The parent settle takes a one-minute lease; any task's meter settles the parent by
  id (`DynamoMeter.adopt`). A call admitted by a task that died is counted at its whole estimate after the call ceiling plus 15
  minutes (`EVAL_DEAD_CALL_MS`), and the stage keeps its whole hold. The 8-per-company limit is one slots item per company (a
  conditional write before any money moves); the 2,000 limit now bounds holds being made at once per task. Waiting for a turn
  polls the table at most once a second. Rows expire (TTL) at the deadline plus `EVAL_DEAD_CALL_MS`; the sweep reads the
  sparse `due-stages` index (stopped stages at once, open ones at their deadline).
- Stage calls with an unknown price settle at the cautious hold; the parent settle is flagged estimated but carries no
  per-call usage, so R3c corrections do not lower them (conservative).

## Eval spend authority (DEC 253k; `eval-authority.ts`)

Rovara Code's `eval-reservation` plug-in point (Code PR #805, `core-host/eval-authority-http.ts`) asks the gateway whether a
project's approved eval spend may spend now. The gateway is the source of truth: its stored approval plus the project's own
connected product key. Never Rovara-paid: the answer's `provider` is always `customer`, and only with the project's own key.

| Request | Body | Answer |
|---|---|---|
| `POST /v1/product/eval/authority`, `authorization: Bearer <service token>` | exactly `{"company","project","approver":{"personId","provider"}}` | `200` exactly `{"company","project","principal":{"companyId","personId","displayName","roles","provider"},"provider":"customer","connected":true}` |

- **Token**: the install's task key signs it (as the offered-models token, `docs/model-gateway-offered-models.md`): header
  `typ: rovara-service+jwt`, claims exactly `iss`/`aud`/`jti`/`iat`/`nbf`/`exp`/`cid`, `aud: "rovara-model-gateway-eval-authority"`,
  at most 60 seconds of life. A task token, the offered-models token or an `x-api-key` header never opens it (`401`).
- **200 only when** the token's `cid` is the body's `company`; the project's stored approval counts now (fresh: 15 minutes from
  the role check Cloud made with Code, and not withdrawn) and names exactly this approver: Code sends the approver's sign-in
  Principal (`personId`, identity adapter `provider`), and Cloud's settings route stored that person's Code developer id
  (`developerIdOf`: sha256 of `developer\0<provider>\0<personId>`, hex) under `rovara-code`, so the gateway compares
  `storedApproverOf(asked)` with the stored approver; the
  approver's role (re-read) is owner, admin or maintainer; and the project's own product key is connected (re-read). The same
  checks the stage hold makes (`ProductEvalStages.authority`). `roles` is that one role; `displayName` is `""` (the gateway
  holds no person's name; Code re-reads the person's role itself before it grants anything).
- **Refusals** are fixed words: `404 not_found` for every "no" (none, stale, withdrawn, another approver, no role, not
  connected, another company's token or body), so nothing says whether another company or project exists; `503 unavailable`
  when a store can't be read; `400` a body that is not exactly the contract (extra or missing members, wrong types, not JSON);
  `413` over 4 KiB (`EVAL_AUTHORITY_BODY_MAX`; a chunked body that grows past it is cut off instead); `405` not a POST; `429`
  past 8 at once or 600 a minute per serving task. The install's signing keys (JWKS) not readable is `401`, as on the
  offered-models route. Code reads every non-200 as "spend not approved".
- Mounted by `startServe` only when the product route holds eval stages; otherwise the path is the gateway's 404. It moves no
  money: the hold is still `/v1/product/eval/hold` with the task token.

## Eval monthly cap (DEC 253q c; `eval-cap.ts`)

Code's `eval-reservation` adapter has an optional `monthlyCapMicros()`. It reads the cap here, from Cloud's company budget (the
same `CompanyBudgetCaps.capsFor` read every agent call makes): the lower of the company's monthly cap and the project monthly
cap. A project with no cap of its own is held to the company cap.

| Request | Body | Answer |
|---|---|---|
| `POST /v1/product/eval/cap`, `authorization: Bearer <service token>` | exactly `{"company","project"}` | `200` exactly `{"company","project","monthlyCapMicros"}` (a whole number, 0 to `Number.MAX_SAFE_INTEGER`) |

- **Token**: as the eval authority's, with `aud: "rovara-model-gateway-eval-cap"` (`EVAL_CAP_AUDIENCE`). Another audience (the
  eval authority's included), a task token or an `x-api-key` header is `401`.
- **No source is refused**: `404 not_found` (fixed) when the body's company is not the token's `cid`, the project is not a
  project name, or the company has no budget source (no settings row, a company monthly cap of null, another company's row) or a
  value that is not whole. `503` when the budget can't be read; `400`, `413`, `405` and `429` as on the eval authority.
  Nothing from the request is echoed or logged.
- **Advisory bound**: this is the cap Code holds an eval spend item to at confirm. The binding check is still the gateway's own eval hold (`/v1/product/eval/hold`, the product caps), which may be lower; a hold it refuses spends nothing.
- Mounted by `startServe` always: the company budget source (`GATEWAY_COMPANY_TABLE`) is part of every serving gateway.

## Not built here

Code's worker side of the bridge; a Code event that tells Cloud about member changes made in Code itself (until then the
approval's 15 minutes bound them). The company's learning accounts have their own settings ("Learning AI key",
docs/model-gateway-learning.md).
