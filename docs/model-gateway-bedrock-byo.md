# Bring your own Bedrock (DEC 238)

A company runs its agents on its OWN AWS account's Amazon Bedrock. Nothing secret is stored. The company's AWS admin creates an
invoke-only IAM role that trusts one Rovara role, the **Bedrock broker**, and only with the company's **external id** and its
**company id as the session name**. Bedrock bills the company's AWS account. Rovara's meter counts each call at AWS list price
under the company's one combined monthly cap; it writes no billable line. The design and its checks are in the research repo's
`briefs/bedrock-byo-design-2026-11-15.md`.

Slice 1 is agents; slice 2 (the product route, below) is the customer's tests. Learning and lesson embeddings come later (see the end).

## The pieces

| Piece | Where |
|---|---|
| The connection (strict parse, external ids, role template, set-up command, presets) | `packages/model-gateway/src/bedrock-byo.ts` |
| Broker, then customer role, per company; the connection test | `packages/model-gateway/src/bedrock-byo-sessions.ts` |
| Provider `bedrock` in the key store: one company-level source, its test, role claims | `packages/model-gateway/src/product-keys.ts` |
| Cloud's signed set-up and test calls | `packages/model-gateway/src/service-call.ts` (`/v1/service/bedrock-setup`, `/v1/service/bedrock-check`) |
| Agent route, source `bedrock_byo` | `packages/model-gateway/src/server.ts` (`companyKeyAgentRoute`), `agent-ai.ts` (`ByoBedrock`) |
| Product route (slice 2): path, guards, usage readers, errors, passthrough transport | `packages/model-gateway/src/product-bedrock.ts`; mounted in `product-route.ts`; bridge `product-bridge.ts` (`PRODUCT_BEDROCK_BRIDGE`) |
| Project routes (slice 2): own role, link, setup command | `packages/cloud-server/src/product-ai-routes.ts` (`/projects/:name/product-ai/bedrock...`) |
| Settings routes | `packages/cloud-server/src/bedrock-byo-routes.ts` (`/org/bedrock...`); `agent-ai-routes.ts` lets an admin choose it once connected |
| Broker role and external-id key | `infra/lib/model-gateway.ts` (`-c rovaraModelGatewayBedrockByo=on`, needs product AI on; refused for production) |
| The customer's role template, for the docs site | `docs/bedrock/rovara-bedrock-role.json` (a test holds it equal to `bedrockRoleTemplate()`) |

## How a company connects

1. A company admin opens the set-up (`GET /org/bedrock/setup/<region>`). Cloud asks the gateway, in a call signed with the
   product key store's HMAC key, for the company's external id and the broker role's ARN. Only the gateway can make the external
   id: it is `rvb-` plus 160 bits of an HMAC of (install, company) under the gateway's own KMS key (`BedrockExternalIdKey`).
2. The admin picks a Region and models (presets follow the Region's geography: `eu.` from `eu-west-1`) and gets one command
   (`POST /org/bedrock/setup`) for **AWS CloudShell** in that Region. It downloads the template from the docs site, checks its
   SHA-256 against the hash pinned in the gateway (a changed file stops it before any role is made), and runs
   `aws cloudformation deploy` with every parameter filled in and single-quoted, then prints the role ARN.
   - Each agent model name must be the same model as the Bedrock id picked for it (dates, versions and the profile prefix aside),
     so a call is never sent to, or priced as, a different model.
   - Why not CloudFormation's one-click quick-create link: its `templateURL` must point at Amazon S3 (AWS docs, "Use quick-create
     links", checked 2026-11-15), and DEC 238 Q10 rules out a public bucket. If the owner later allows a public S3 object, the
     quick-create link is a small addition.
3. The admin pastes the role ARN (`PUT /org/bedrock`). The store refuses a role another company holds, then asks the gateway to
   test it, then seals it in the company document as source `src_bedrock`.
4. A removal keeps the connection for 7 days; the company admin can undo it then (`POST /org/bedrock/recover`).
5. Under "AI for your agents" the admin picks "your own Bedrock". It is refused until a connection is saved. There is one active
   source and never a fallback.

## The connection test (at connect and rotate, nothing cached)

- The real company must get a session (broker, then the role, with its external id and session name). Else "AWS refused".
- Only STS's `AccessDenied` counts as a refusal. A throttle or any other error makes the test "unavailable" (never "ok"), and on
  the call path it is the fixed 503, never shown as "AWS refused".
- Two canaries must be refused: the real session name with a canary company's external id, and a canary session name with the
  real external id. If either works, the role is **too open** and nothing is saved.
- Each picked model gets one **$0 check**: an InvokeModel with `max_tokens: 0`, which IAM authorises and Bedrock rejects as
  invalid. `ValidationException` means ready; `AccessDeniedException` with Bedrock's model-access words means **not enabled yet**
  (Settings shows the steps: open the model once in the Bedrock console as an AWS admin with Marketplace rights; for Anthropic
  models before Claude Opus 4.7, submit the use-case form); any other AccessDenied means the role may not call that model; an
  unknown id is not found. A model the test did not answer is shown as unavailable, never as ready.

## Isolation

- The external id and the session name come from the verified company id (the task token, or Cloud's signed call), never from
  the request or from stored customer data. Company B pointing at company A's role sends B's id and name, so A's trust refuses.
- A role connected by one company is refused for every other company (DEC 238 Q5): a claim row per (account, lower-cased role
  name), written in the same transaction as the connection. A removed role stays claimed through the 7-day recovery window.
- Sessions are cached per key-store row (install, company, owner, source, version) for at most 55 minutes (role chaining caps a
  session at one hour); a refusal is never cached; a 401/403 from Bedrock forgets the session.
- The broker may only assume `RovaraBedrockInvoke-*` roles in OTHER accounts (`aws:ResourceAccount` is not Rovara's), with an
  `rvb-*` external id and an `org_*` session name. It has no Bedrock rights. Its name and logical id are fixed; the external-id
  key has a fixed alias and a pinned logical id (a renamed construct fails the deploy on the alias). A property change that
  replaces the key would only re-point the alias, so never change the key's properties: its KeySpec and KeyUsage are pinned in
  the contract test. The customer role has only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the picked
  models, and global routing is denied unless the admin turned it on.

## Money

- Priced at the dearer of the Bedrock row (already the dearest of the fetched Regions) and the Anthropic row of the model the
  agent named, so the cap never counts less than either list price. Discounts are not entered (DEC 238 Q7).
- Bedrock's error answers carry no output: free. A stream that breaks after output started is charged by the core's rule.
- The one combined company cap applies. No billable line: the company's AWS bill is the record.

## Not verified yet (owner checks)

- That Bedrock checks model access BEFORE it validates `max_tokens` (the $0 check's order). If not, a "ready" model may still
  answer "not enabled yet" on its first real call (free, and shown in those words). DEC 238 Q9 allows a test call under $0.001 if
  the $0 check proves unreliable.
- That `sts:ExternalId` is evaluated in the broker's identity policy (AWS documents it for trust policies). If not, calls fail
  closed; the fix is to drop that condition (the customer's trust policy still requires the external id).
- Whether global profiles are priced above the Regional rows for the newest Claude models (global is off by default).

- An operator release of a deleted company's role claim (today a deleted company's claim stays until removed by hand).

## Slice 2: the product route (the customer's tests)

`/v1/product/bedrock/model/{id}/{converse,converse-stream,invoke,invoke-with-response-stream}` (`src/product-bedrock.ts`, mounted by
`src/product-route.ts` when bring-your-own Bedrock is configured). The sandbox's AWS SDK has `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` set to
the worker's local port and dummy credentials; the worker removes the credential headers, adds the task token and forwards (bridge
contract v2: `contracts/shared/model-gateway-product-bedrock.v2.json`, `PRODUCT_BEDROCK_BRIDGE`; the Code worker's header strip is the
Code half and is not in this repo). The gateway signs for the company's own role and passes AWS's bytes back unchanged (a stream is
`application/vnd.amazon.eventstream`).

- **Whose role:** the project's own (`PUT /projects/:name/product-ai/bedrock`, for example a separate test account), or a link to the
  company's (`.../bedrock/link`, a link never a copy; removing the company's source ends every link at once). A project holds one
  Bedrock source. The same external id, session name, connection test (canaries) and role claim as the company's apply to a project's
  own role: a role held by another company, project or source is refused.
- **Models (DEC 238 Q6):** the connection's `models` (the agents' Claude picks) plus `productModels`: up to 8 more Bedrock ids or system
  profiles of the Region's geography, any family, and Titan text embeddings (V1, V2). At most 12 different ids in all (the IAM
  parameter limit). They go into the role's IAM resources and the $0 test. A model not picked is refused.
- **Operations (Q8):** Converse and ConverseStream for every picked model; InvokeModel(WithResponseStream) only for Claude's Anthropic
  body, and InvokeModel for Titan embeddings. Refused with fixed words: provisioned throughput, application inference profiles and
  prompts (ARNs), guardrails, priority/latency tiers (`serviceTier`, `performanceConfig`, `x-amzn-bedrock-*` headers), system tools,
  S3-located media, citations, every unknown field or block, and every other InvokeModel body.
- **Body guard:** `inferenceConfig.maxTokens` is held to the model's price-snapshot output ceiling (4,096 when there is no row; a request
  above it is refused, none asked is set to it); one total item count and the 4 MiB body limit; `additionalModelRequestFields` only
  `top_k`, `thinking` and the allowed betas; images, documents, video and cache points make the input not byte-bounded (the overrun
  rules, DEC 165). Claude's InvokeModel body goes through the agent route's own guard first.
- **`requestMetadata`:** the gateway sets `{rovara_project, rovara_task}` on every Converse call and overwrites a caller's value, so the
  customer's invocation logs join to Rovara's tasks.
- **Money:** same core as the other product calls: the project's caps clamped by the company ceiling, the project's own meter and the
  ONE combined company cap. List price: the Bedrock row (dearest of the fetched Regions), and for a Claude id also the Anthropic row of
  each agent model name picked for it (the dearer of the two). Usage from Converse's `usage` (or the stream's final `metadata`), the
  Anthropic message or chunks, or a Titan answer's `inputTextTokenCount`; anything unreadable settles at the full hold. No billable
  line: the customer's AWS bill is the record. A Titan embedding is priced as kind `embedding`; the AWS price list holds no
  embedding rows today, so it is priced at the cautious fallback (never below the real price, far above it) until those rows exist.
- **Errors:** read only to classify, never echoed. A refused role (401/403) is free, marks the source for Settings and drops the
  session; "model not enabled yet", a throttle, a quota, a bad request and a missing model are free; a timeout or a server error after
  the send is charged at the hold, as for every provider. Refusal bodies carry a top-level `message` (the AWS SDK reads that) and the
  usual `error.type` and `error.message`.

## Later slices (not built)

- **S3, learning:** learning calls on the company's Bedrock, the `anthropic-beta` filter, and Settings refusal words. Non-Claude
  coding models through Converse for agents (as Rovara's AI does) belong here too.
- **S4, lesson embeddings** through Bedrock (Titan Text Embeddings V2 or Cohere Embed), after the DEC 231a embedding path. Cohere
  needs the answer's token-count header (the product route serves Titan only: its body carries the count).
- **S5, Settings UI:** the connect page, model picker, test result and warnings, and the usage note.

Setup note (slice 2): a project's own role has its own CloudFormation stack (`rovara-bedrock-<company>-<project>`), so its command never
updates the company's stack. The template names the role from the company id, and IAM role names are account-wide: a project's own role
is created in a different AWS account than the company's role (in the same account the stack fails to create; nothing is changed).
Known gap (Low): a 403 for one product model that is missing from the role's policy marks the whole connection refused in Settings (the
agents still work) and drops the session; the fix is to tell a model refusal from a credential failure once AWS's wording is confirmed.

### Customer-source overage stop per route class

Every agent, product and reviewer call on `bedrock_byo` or `openrouter` reserves one durable slot in
`meter / CO#[iss,cid] / SOURCESTOP#<source>`, atomically with its money hold. There
is at most **one in-flight call per company and source**, across processes, tasks
and accounting months, with combined product/agent meters sharing the agent record. No TTL frees this slot: settlement or the existing dead-hold
sweep releases it. A failed settlement retains the hold/slot. An over-hold receipt
or revision atomically stops only the admitted route class, preserving its true cost:
`SOURCESTOP#<source>#product` (all four product Bedrock operations) or
`SOURCESTOP#<source>#agent` (agents, streaming/fallback, reviewers and upkeep).
The hold and ledger retain the admitted class for settlement and later revisions.
Each reserve transaction fences both its class record and the class-less shared slot.
Unknown or missing classes on customer-source reservations refuse before sending.
A pre-migration class-less stop continues to block **both** classes until explicitly
cleared with `--class legacy`; clearing a product/agent stop never clears it.
Legacy holds/ledger rows that lack a class continue to latch the class-less stop. Corrections
never read or write the stop. Independent cap-overrun latches remain separate.
Do not roll back past round C while a source stop is active. No rollback to round E
while a class stop is active: round E ignores the product and agent stop records.

Bedrock reviewer calls keep the grant's durable session/debit ceiling, and take
an individual priced meter hold and receipt for **each** call (rather than keeping
one ceiling-sized meter hold for the session). This enforces the source slot and
caps for every call, records its actual bill, and stops and alarms above its hold.
The session's debits authorize calls only up to its ceiling; an unexpected bill
above that ceiling is still recorded in full. Other reviewer sources retain their
existing session-sized hold. Sessions bind their funding source (including its
connection revision) and accounting mode. A changed source or mode cannot reuse
the old hold: admission takes a fresh hold, checks its caps, then refuses the
incompatible grant before sending. Any unused new hold settles once at zero;
the existing session and its hold remain unchanged. A fresh grant is required.

Only the local interactive operator CLI clears a stop. It resolves the operator's
IAM **user** ARN using STS with the same exported credentials used for DynamoDB;
workload/assumed-role/root identities and noninteractive input are refused. It
prints the exact issuer, company, source, route class, record key, stop, amounts and target tables, asks for
an exact confirmation phrase, then conditionally clears only that stop while
writing who/when/why into the ledger (`SOURCESTOPCLEAR#<source>#<class>#<stopId>`, including the class), in one transaction.
A changed stop or a live call makes the confirmation stale. Spend, accounting cap
latches, other route classes, legacy stops and other sources are untouched. This adds no serving-role IAM grant,
web route, feature switch or step-up. The operator needs existing table write
permissions; the serving process never exposes this action.

After building, run locally (with real identifiers and a meaningful reason):

```sh
node scripts/model-gateway-source-stop-clear.mjs \
  --issuer https://code.example/v1/auth --company org_aaaaaaaaaaaaaaaaaaaa \
  --source bedrock_byo --class product --reason 'Reviewed invoice and corrected configuration' \
  --region us-west-2 --meter-table <agent-meter-table> --ledger-table <agent-ledger-table>
```

Geo-profile aliases (`us.`, `eu.`, `apac.`, `global.`) currently share the **dearest**
observed Bedrock price identity. A regional premium therefore raises every alias's
hold rather than being replaced by a cheaper global observation. This is
conservative pooling, not live AWS tariff qualification.
