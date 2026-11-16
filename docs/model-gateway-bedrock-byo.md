# Bring your own Bedrock (DEC 238)

A company runs its agents on its OWN AWS account's Amazon Bedrock. Nothing secret is stored. The company's AWS admin creates an
invoke-only IAM role that trusts one Rovara role, the **Bedrock broker**, and only with the company's **external id** and its
**company id as the session name**. Bedrock bills the company's AWS account. Rovara's meter counts each call at AWS list price
under the company's one combined monthly cap; it writes no billable line. The design and its checks are in the research repo's
`briefs/bedrock-byo-design-2026-11-15.md`.

Slice 1 (this page) is agents only. The product route and learning come later (see the end).

## The pieces

| Piece | Where |
|---|---|
| The connection (strict parse, external ids, role template, set-up command, presets) | `packages/model-gateway/src/bedrock-byo.ts` |
| Broker, then customer role, per company; the connection test | `packages/model-gateway/src/bedrock-byo-sessions.ts` |
| Provider `bedrock` in the key store: one company-level source, its test, role claims | `packages/model-gateway/src/product-keys.ts` |
| Cloud's signed set-up and test calls | `packages/model-gateway/src/service-call.ts` (`/v1/service/bedrock-setup`, `/v1/service/bedrock-check`) |
| Agent route, source `bedrock_byo` | `packages/model-gateway/src/server.ts` (`companyKeyAgentRoute`), `agent-ai.ts` (`ByoBedrock`) |
| Settings routes | `packages/cloud-server/src/bedrock-byo-routes.ts` (`/org/bedrock...`); `agent-ai-routes.ts` lets an admin choose it once connected |
| Broker role and external-id key | `infra/lib/model-gateway.ts` (`-c rovaraModelGatewayBedrockByo=on`, needs product AI on; refused for production) |
| The customer's role template, for the docs site | `docs/bedrock/rovara-bedrock-role.json` (a test holds it equal to `bedrockRoleTemplate()`) |

## How a company connects

1. A company admin opens the set-up (`GET /org/bedrock/setup/<region>`). Cloud asks the gateway, in a call signed with the
   product key store's HMAC key, for the company's external id and the broker role's ARN. Only the gateway can make the external
   id: it is `rvb-` plus 160 bits of an HMAC of (install, company) under the gateway's own KMS key (`BedrockExternalIdKey`).
2. The admin picks a Region and models (presets follow the Region's geography: `eu.` from `eu-west-1`) and gets one command
   (`POST /org/bedrock/setup`) for **AWS CloudShell** in that Region. It downloads the template from the docs site and runs
   `aws cloudformation deploy` with every parameter filled in, then prints the role ARN.
   - Why not CloudFormation's one-click quick-create link: its `templateURL` must point at Amazon S3 (AWS docs, "Use quick-create
     links", checked 2026-11-15), and DEC 238 Q10 rules out a public bucket. If the owner later allows a public S3 object, the
     quick-create link is a small addition.
3. The admin pastes the role ARN (`PUT /org/bedrock`). The store refuses a role another company holds, then asks the gateway to
   test it, then seals it in the company document as source `src_bedrock`.
4. Under "AI for your agents" the admin picks "your own Bedrock". It is refused until a connection is saved. There is one active
   source and never a fallback.

## The connection test (at connect and rotate, nothing cached)

- The real company must get a session (broker, then the role, with its external id and session name). Else "AWS refused".
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
- The broker may only assume `RovaraBedrockInvoke-*` roles, with an `rvb-*` external id and an `org_*` session name. It has no
  Bedrock rights. The customer role has only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the picked
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

## Later slices (not built)

- **S2, product route:** `/v1/product/bedrock/model/{id}/{converse,converse-stream,invoke,invoke-with-response-stream}`, body
  guard (model forms, maxTokens clamp, refuse provisioned throughput, guardrails, priority/latency tiers and application profiles),
  `requestMetadata` set by the gateway, a project's own role or a link to the company's (the store refuses both today), bridge
  contract v2 with the Code worker's header strip.
- **S3, learning:** learning calls on the company's Bedrock, the `anthropic-beta` filter, and Settings refusal words. Non-Claude
  coding models through Converse for agents (as Rovara's AI does) belong here too.
- **S4, lesson embeddings** through Bedrock (Titan Text Embeddings V2 or Cohere Embed), after the DEC 231a embedding path.
- **S5, Settings UI:** the connect page, model picker, test result and warnings, and the usage note.
