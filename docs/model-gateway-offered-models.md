# Offered agent models (agents pick models)

DEC 243c (Rovara's AI offers every Bedrock coding model), DEC 236j (model choices are made on the web page only) and DEC 240 (the customer pays).
Rovara Code's contract is `OfferedAgentModels` (`contracts/shared/offered-agent-models.v1.json`; Code's `packages/contracts/src/agent-model-choice.ts`, PR #771).

## The route

`GET /v1/service/companies/<companyId>/offered-models` on the gateway, company-key mode only (`GATEWAY_AGENT_KEYS=company`).
It answers `{ "version": 1, "models": [ { "model": "<name>" }, ... ] }` (1 to 64 names, one per model), or a refusal, never an empty list.

- `rovara`: every name of the gateway's Rovara's AI allow-list (`GATEWAY_ROVARA_AI_MODELS`; one name per Bedrock id, so a dated alias is not a second model), minus `GATEWAY_AGENT_MODELS_DISABLED`.
  Absent that variable, Sonnet 5.5, Opus 5.5 and Fable 5.2 are left off (they answer `model_not_enabled` until the account's one-time Marketplace enable). Set it (empty for none) to change that; no deploy of code is needed.
- `anthropic_key`, or no choice saved (company-key mode): Anthropic's models (`ANTHROPIC_KEY_AGENT_MODELS`). The disabled list is Bedrock account state, so it does not apply.
- `bedrock_byo`: refused (403, not built). `rovara` while Rovara's AI is off here: refused (403). A source that cannot be read: 503.
- The names are the ids the agent route accepts (the engine name for Claude, the Bedrock id for the rest).

## Authentication

A service token the Code install's broker signs with its task key (the one the agent route's task tokens use), sent as `Authorization: Bearer <jwt>`:

- header exactly `{ alg: RS256, typ: "rovara-service+jwt", kid: <pinned task kid> }`;
- claims exactly `iss` (the install's issuer), `aud: "rovara-model-gateway-offered-models"`, `jti` (UUID), `iat`, `nbf = iat - 30`, `exp <= iat + 60`, `cid` (the company);
- verified by the same pinned issuer, pinned key ids and JWKS as task tokens (`token.ts` `createSignedTokenVerifier`). A task token never opens this route and a service token never opens `/v1/messages`.
- The company is the token's `cid`; the path must name the same company or the call is refused like an unsigned one.

The vertex-check HMAC is Cloud's own KMS key (only Cloud's settings role signs with it), so it is not available to Code's broker.
