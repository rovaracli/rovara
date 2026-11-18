# Offered agent models (agents pick models)

DEC 243c (Rovara's AI offers every Bedrock coding model), DEC 236j (model choices are made on the web page only) and DEC 240 (the customer pays).
Rovara Code's contract is `OfferedAgentModels` (`contracts/shared/offered-agent-models.v1.json`; Code's `packages/contracts/src/agent-model-choice.ts`, PR #771).

## The route

`GET /v1/service/companies/<companyId>/offered-models` on the gateway, company-key mode only (`GATEWAY_AGENT_KEYS=company`).
It answers `{ "version": 1, "models": [ { "model": "<name>" }, ... ] }` (1 to 64 names, one per model), or a refusal, never an empty list.

- `rovara`: every name of the gateway's Rovara's AI allow-list (`GATEWAY_ROVARA_AI_MODELS`; one name per Bedrock id, so a dated alias is not a second model), minus `GATEWAY_AGENT_MODELS_DISABLED`.
  Absent that variable, Sonnet 5.5, Opus 5.5 and Fable 5.2 are left off (they answer `model_not_enabled` until the account's one-time Marketplace enable). Set it (empty for none) to change that; no deploy of code is needed.
- `anthropic_key`, or no choice saved (company-key mode): Anthropic's models (`ANTHROPIC_KEY_AGENT_MODELS`). The disabled list is Bedrock account state, so it does not apply.
- `bedrock_byo` (DEC 238, slice 1): the Claude names of the company's OWN connection (`models`, read for the token's install and company only), the same models the agent route accepts for it. Not connected or not built on this gateway: 403; unreadable: 503. The disabled list does not apply.
- `rovara` while Rovara's AI is off here: refused (403). A source that cannot be read: 503.
- The names are the ids the agent route accepts (the engine name for Claude, the Bedrock id for the rest).

## Authentication

A service token the Code install's broker signs with its task key (the one the agent route's task tokens use), sent as `Authorization: Bearer <jwt>`:

- header exactly `{ alg: RS256, typ: "rovara-service+jwt", kid: <pinned task kid> }`;
- claims exactly `iss` (the install's issuer), `aud: "rovara-model-gateway-offered-models"`, `jti` (UUID), `iat`, `nbf = iat - 30`, `exp <= iat + 60`, `cid` (the company);
- verified by the same pinned issuer, pinned key ids and JWKS as task tokens (`token.ts` `createSignedTokenVerifier`). A task token never opens this route and a service token never opens `/v1/messages`.
- The company is the token's `cid`; the path must name the same company or the call is refused like an unsigned one.

The vertex-check HMAC is Cloud's own KMS key (only Cloud's settings role signs with it), so it is not available to Code's broker.

## Reviewer access and reviewer grants (DEC 254zzz41, lane L4-GW6)

Second review and design review run as one model call each, made with a 120 second task token that carries a `reviewer` grant
(`{ kind, slot, ceilingUsd }`; Code's contract, `contracts/shared/model-gateway-token.v1.json`).

- **`reviewerAccess` on the offered-models answer** (`src/offered-models.ts` `reviewerAccessFor`): `{ companyId, companyLimitUsd, models: [{ model, provider }] }`,
  present only when the company's saved source is really connected now (an own-key source needs its key connected; Rovara's AI, own Bedrock and own
  endpoint were just read) and the company has room left in its one cap (`src/reviewer-grants.ts` `companyRoomMicros`). A model's provider is its
  vendor on Rovara's AI and one fixed name on every other source, so a company on one connection has no second provider and its review stays
  unavailable. Absent, the answer is byte-identical to before.
- **Same payer as the main AI**: the grant is served only by the agent route in company-key mode and goes through the same admission as the task's main
  call (the company's saved source, resolved by the token's company). There is no company payer variant. Any other route, and install-key mode, answer 401.
- **Inside both limits, held up front**: the first call of a review holds the grant's WHOLE `ceilingUsd` through the ordinary reservation, so the task's cap and the
  company's cap both apply to the full ceiling before any provider call, and a refusal spends nothing. Each call is then held at its exact priced worst case,
  which is debited from that held ceiling (an estimated price, unbounded input, an own-cost source or a derived tier is refused; a call is never recorded above its worst case).
- **One grant, one review (session)**: the first use claims the grant's jti and opens a review session with one conditional put in the markers table
  (`CO#[iss,cid]` / `REVGRANT#<jti>`: hold id, ceiling, room left, end time; `expiresAt` TTL; no new table, record kind or IAM). Later calls of the SAME review (same jti, same
  company, project, task, workspace, operation, kind, slot and model, including a renewed token with the same jti) debit the session, never past the ceiling and for at most
  600 seconds. What a call did not use is given back at once. When the session ends the gateway closes it: the hold settles at what the review really used and the rest of the
  ceiling is released (an in-process timer 30 seconds after the end; if the gateway task died, the open-hold sweep settles a review's hold at what its session debited, found
  through the `review` jti stored on the hold, and only a session that cannot be read costs the whole ceiling). A replay of the same grant is therefore a continuation of its
  review until the ceiling, the session or the grant's own 120 seconds end (the owner decision's "replay refused" holds once the session is exhausted, ended or closed). A mismatch, an exhausted ceiling, an ended or closed session, a
  grant past its 120 seconds or a store that does not answer gives the fixed 401 and spends nothing.

## The company's source order (DEC 254zzz84(4))

A company can save an ORDER of AI sources for its agents (Cloud's Settings, AI models, Sources: `GET /org/model-sources`, `PUT /org/model-sources-order`,
`packages/cloud-server/src/model-sources-routes.ts`; owners and admins change it, any member reads it). It is the same `COMPANY#<org>` / `AGENT_AI` row:
`source` is the first choice and the optional `fallback` holds the sources after it, in order (distinct, never the first choice, at most 5). A row without
`fallback` is exactly the single saved choice of before, and `PUT /org/agent-ai` keeps the later sources (minus the new first choice).

- **Agent route** (`src/server.ts`, the company-key route's `admit`): with a saved fallback, the call is admitted on the FIRST source of the order that is
  switched on, offered by this gateway, connected for the token's verified company, and serves every model the token allows. This is decided before any
  hold or send: one call goes out on one source, and a provider's answer (an error included) never moves it to another. A read that fails (a store or a
  connection that does not answer) refuses the call at once (503): it is never slid onto the next source or onto Rovara's AI. When no source can take the
  call, the first source's refusal is answered. The `agent_source` log line says `via: "fallback"` when the call was admitted on a later source.
  A fallback to Rovara's AI is charged to the company like any Rovara's AI call, inside the same caps.
- **Offered models**: with a saved fallback, the list is the models of every usable source of the order, in order, each once (at most 64); a failed read anywhere
  is the fixed 503. Without one, the answer is the first choice's, byte for byte. `reviewerAccess` lists each model under the source that offers it.
- Learning and answers keep using the first choice only.
