# Model gateway: the product-AI route

Plan v3.2 row 20.2 (the Gemini journey), section 7.4 item 7; DEC 157, 165, 172, 214 #18, 216, 217.
Code: `packages/model-gateway/src/product-*.ts`. `startServe` mounts it when given `product` (resolver, its own meter on
separate tables, its caps); the deployed process does not pass it yet (the product key table adapter and the product
meter tables are infra/adapter rows).

With the runtime from #53: the product route reads the company backend's budgets (`CompanyBudgetCaps`, fail closed: a
company with no monthly cap or an unreadable row gets no product calls; the monthly cap also bounds the product meter's
company row, with the product ceiling), takes each Gemini model's own output ceiling from the price rows
(`productModelLimitsFrom(prices)`; no row: 65,536), and its open holds, expiry and corrections run in the same
maintenance pass as the agent meter's (`sweepOpenHolds` on the product meter). The company backend's monthly cap is
applied to product spend and agent spend on separate meters, so each may use up to that cap.

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

## Engine bridge (`contracts/shared/model-gateway-product-ai.v1.json`)

The worker's trusted part sits between the sandbox and the gateway. The sandbox's test calls the worker's local port
with a dummy Google key; the worker removes Google credential headers and any `key=` query, adds the task token it
already holds (`GET /v1/internal/model-access`, Code #670) as `x-api-key`, and forwards to `<baseUrl>/v1/product/...`.
The file lists paths, headers, and every refusal (status, type, fixed words). Code's worker copies it byte for byte
(SHA-256 pinned in a test).

## Deployment conditions (not enforced in code)

- The product meter is a separate Meter instance (table or key prefix) from the agent meter.
- The deny statement (`productKeyDenyStatement`) also blocks `kms:GenerateDataKey*`: whatever process runs the settings
  routes that seal keys must be the gateway's runtime role, or be exempted explicitly.
- The sandbox never holds the task token (Code's worker; plan 7.4 gap c).

## Against Code's eval wiring (#683, `EvalModelAccess.hold`)

Met: the TC-1 task token (#670); the product key injected server-side and never shown; one attempt per call; whole
micro-dollars, `estimated` when the price is unknown; a 10 MiB answer cap; a cut-off or malformed answer is never a clean
success; isolation by install and company. Not yet: a stage-level hold (one atomic hold of the whole stage estimate with
`release({calls, costMicros, unknown})`), the project eval budget and grant (company, project, selection) checks, a
count-of-calls limit, an `overrun` field on the settle, the outcome words `rate_limit`/`quota`/`overloaded` as separate
answers, and Vertex. Today each call holds its own worst case against the product caps.

## Not built here

Vertex (federation and key file: follow-up PR), the DynamoDB adapters, the settings HTTP routes and screens, infra (the
runtime role, the deny statement attached to non-gateway roles, the KMS key), Code's worker side of the bridge.
