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
- **Inside both limits**: the call is held at its exact priced worst case (an estimated price or unbounded input is refused) which must fit `ceilingUsd`,
  through the ordinary reservation, so the task's cap and the company's cap both apply and a refusal spends nothing.
- **Single use, durable**: after the hold and before any key is read, the grant's jti is claimed once with a conditional put in the markers table
  (`CO#[iss,cid]` / `REVGRANT#<jti>`, `expiresAt` = exp + 300 s). A scope or model mismatch, a grant past its 120 seconds, a replay (also after a restart or on
  another gateway task) or a store that does not answer gives the fixed 401 and the hold is given back; no new table, record kind or IAM.
