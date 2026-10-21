# Model sources spike: per-org model sources through LiteLLM (Plan 3, Task 2)

Date: 2026-10-20. Throwaway spike; the harness (a Python wire mock, a Python driver, shell helpers) lived in the session scratchpad and is not merged. Only these findings are.

## Setup

- LiteLLM `ghcr.io/berriai/litellm-database:v1.105.1@sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e` (the R24 digest, the same as `LITELLM_IMAGE` in `infra/lib/model-proxy.ts`). `postgres:16`. Docker on colima, one user network, no compose plugin.
- Two proxy replicas on one shared Postgres (`STORE_MODEL_IN_DB=True`, shared `LITELLM_SALT_KEY`, `LITELLM_LOCAL_MODEL_COST_MAP=True`), a second LiteLLM with no database (the `endpoint` upstream), and a stdlib Python wire mock that speaks Anthropic Messages, OpenAI Responses and OpenAI Chat Completions (streaming, tool calls, fixed usage 1000 input / 200 output tokens), plus an HTTPS listener with a self-signed certificate, redirect routes and a canary listener that logs any request it receives.
- No real provider key, no Bedrock call, no AWS resource was created. The only AWS calls were `sts get-caller-identity` and `iam simulate-custom-policy` on profile `agentx-test` (read-only policy evaluation, Q5). Secrets Manager was exercised only against a local fake (Q3).
- LiteLLM's own `mock_response` parameter cannot stand in for an upstream on these routes: on `/v1/messages` a streamed request returns plain JSON, on `/v1/responses` a streamed request fails with a 500, no tool call is produced, and token counts are estimated from text (not the real usage). It was run and is recorded below, but the wire mock and the second LiteLLM are the evidence for Q4 and Q6.

## Results at a glance

| # | Question | Result |
|---|---|---|
| 1 | `STORE_MODEL_IN_DB` with `/model/new` and `/model/delete` across 2 replicas | **GO** |
| 2 | Isolation (key `models`, discovery routes, team `models`) | **GO, with three binding conditions** |
| 3 | Credentials | `/credentials` API **GO**; Secrets Manager reference **NOT TESTED** against real AWS (mechanism passes a local fake, but unsuitable for dynamic names) |
| 4 | Transports `anthropic-messages`, `openai-responses`, `openai-completions` | **GO** for all three (wire mock and second LiteLLM); vendor upstreams **NOT TESTED** |
| 5 | Bedrock in another account | Documentation and parameter confirmed; the live same-account denial is **NEEDS HUMAN** (**NOT TESTED**) |
| 6 | Prices | **GO** |
| 7 | Per-alias health | **GO** |
| 8 | Client-side overrides refused | **NO-GO** on the stock proxy (`api_key` and `extra_headers` are not refused); a config-embedded pre-call hook fixes it (verified) |
| 9 | Redirects not followed | **NO-GO** (every transport follows 3xx, including to `http:` and link-local, and reflects the target body in the error) |
| 10 | Per-model `ssl_verify: true` honoured | **GO** (fail closed on all three transports), with caveats |
| 11 | Spend lag | **GO**: `FINALIZE_DELAY_MS = 120000` |
| 12 | Key `metadata` in spend logs | **NO-GO**: Task 30 tags ledger lines from `ModelKeyRecord.tags` |

## Decisions recorded

```
SOURCE_CREDENTIAL_STORE = litellm-credentials-api   (LiteLLM POST /credentials, referenced by litellm_credential_name; encrypted in Postgres under LITELLM_SALT_KEY)
SOURCE_KINDS_AT_LAUNCH  = []                        (see below: openai, anthropic, openrouter need real keys; bedrock needs the Q5 live row; endpoint is blocked by Q9)
TRANSPORTS_AT_LAUNCH    = [anthropic-messages, openai-responses, openai-completions]
INFERENCE_PATHS         = POST /v1/messages, POST /v1/responses, POST /chat/completions, POST /v1/chat/completions
FINALIZE_DELAY_MS       = 120000
```

- `SOURCE_KINDS_AT_LAUNCH` is empty now, not because 1 and 2 failed (they are GO) but because each candidate kind has an open gate: `openai`, `anthropic` and `openrouter` are NOT TESTED against a vendor (per the human's decision) so they stay out until the final cumulative round; `bedrock` needs Q5's live denial (NEEDS HUMAN) and then ships with the NOT TESTED note; `endpoint` needs 8, 9 and 10, and 9 is NO-GO. When the final round passes a vendor row, the kind joins the list; its transports are already GO.
- Plan consequence for the controller: the NO-GO path in the brief (`SOURCE_KINDS_AT_LAUNCH = []`, keys use `models: [catalogId]`) applies at launch for kinds, but the infrastructure (Q1, Q2, Q4, Q6) is proven, so Task 24 onward can be built and kinds enabled one by one.
- Q12 NO-GO: Task 30 tags ledger lines from `ModelKeyRecord.tags`. Spend-log rows do carry `metadata.user_api_key_alias`, `team_id`, the hashed `api_key` and `model_group`, which is enough to join a ledger line to its `ModelKeyRecord`.

## Question 1: models in the database, 2 replicas (GO)

- `POST /model/new` with `model_info.id` stored the model (the `litellm_params` come back encrypted in the response). The replica that took the write served the alias at once.
- The other replica served a new alias on its first call, 0.02 to 0.05 s after the add (3 of 3 trials, plus 2 earlier). Its `/v1/models` listing lagged: 6 s in one trial, 45 s on a cold replica in the first trial. The periodic reload runs every `proxy_config_reload_interval_seconds` (default 30 s, source `proxy_server.py`).
- `POST /model/delete` (`{"id": ...}`) refuses at once on the replica that took the write, but the other replica kept serving the deleted alias for 18, 20, 30 and 30 s (4 trials). A deleted alias is not revoked on all replicas for up to about 30 s: revoke access by key (Q11 revocation lag below), not by alias deletion alone.
- `LITELLM_SALT_KEY` is required for `STORE_MODEL_IN_DB` (credentials are encrypted with it) and must be identical on every replica.

## Question 2: isolation (GO, with conditions)

Two org aliases, `org_aaa--chat` and `org_bbb--chat`, with different `api_base` and upstream key; teams `team-aaa` and `team-bbb` with matching `models`; a key per org with `models: [<alias>]` and `team_id`.

- A key for org A calling org B's alias, any other alias, or a non-existent alias: HTTP 403 `key_model_access_denied` on `/chat/completions`, `/v1/chat/completions`, `/v1/responses` and `/v1/messages`, on both replicas. The own alias returned 200 on all four.
- `/v1/models`, `/models`, `/model_group/info` and `/model/info` (no parameter) list only the key's alias. `/model_group/info?model_group=<other>` returns empty. `/model/info` shows the key's own `api_base` (acceptable) and never `api_key`.
- Team `models` is a working second layer on calls: a key with `models: [A, B]` in a team whose `models` is `[A]` gets 403 on B. Caveat: that key's `/v1/models` still lists B, so the listing does not intersect with the team.
- A key with no `models` and no `team_id` reaches every alias (200 on both orgs' aliases).

Leaks found with an ordinary org key (all closed by the conditions below):

1. `GET /v2/model/info` returns every model, including other orgs' `api_base` (and `static-mock`), on both replicas.
2. `GET /model/info?litellm_model_id=<id>` returns another org's model info, `api_base` included, if the id is known.
3. Keys that omit `models` or `team_id` see everything.

Binding conditions for GO: (a) the proxy's load balancer forwards only the inference paths (`INFERENCE_PATHS`) and `/health/liveliness`; `/v2/model/info`, `/model/info`, `/model_group/info`, `/v1/models` and every management route are not reachable from a worker or sandbox; (b) every key is minted with a non-empty `models` list and a `team_id`; (c) model ids are unguessable (let LiteLLM generate them, never derive them from the org id). Other management routes probed with an org key (`/key/list`, `/team/list`, `/user/list`, `/spend/*`, `/credentials`, `/guardrails/list`, `/config/list` and 20 more) returned 401, 403, 404 or an empty body, and none contained another org's data. `/routes` returns the route list (no tenant data).

## Question 3: credentials

- **`/credentials` API (GO).** `POST /credentials` (`credential_name`, `credential_values: {api_key, api_base}`, `credential_info`) then `/model/new` with `litellm_params.litellm_credential_name`: the other replica served it and the upstream received the credential's key. `GET /credentials` shows the key redacted (`sk****11`); `/model/info` shows only the credential name. An org key gets 401 on `/credentials`. `PATCH /credentials/{name}` needs `credential_name` repeated in the body; the rotated key reached the upstream on both replicas within about 10 s.
- **Secrets Manager reference (NOT TESTED against real AWS).** Creating the throwaway secret `agentx/spike/org-sources/test` is an AWS resource, so it was not done (hard limit, PF29). The mechanism was exercised against a local fake Secrets Manager (the source builds the endpoint from `AWS_BEDROCK_RUNTIME_ENDPOINT` with `bedrock-runtime` replaced by `secretsmanager`): config-file and database models with `api_key: os.environ/<secret-id>` and `key_management_system: aws_secret_manager` resolved the secret and sent it upstream; the database stores the reference encrypted and `/model/info` shows `api_key: None`; the secret is read when the model loads (not on each request). Findings that make it a poor fit for per-org sources: with `hosted_keys` set, a reference not in the list is not resolved (the call failed with "api_key client option must be set"), and without `hosted_keys` every `os.environ/` reference (master key, database url) goes to Secrets Manager first. Resolving new names would need a restart or a static list. A real-AWS row stays NOT TESTED.

## Question 4: transports (GO)

Each of `/v1/messages` (`anthropic-messages`), `/v1/responses` (`openai-responses`) and `/chat/completions` (`openai-completions`) was run with a text call, a streamed text call, a tool call and a streamed tool call. Upstreams: (b) the wire mock, native route (`anthropic/` for Messages, `openai/` for Responses and Completions); (c) a second LiteLLM in front of the wire mock (`api_base` the second proxy's origin). All 24 requests returned 200. Streams were `text/event-stream` (6 to 11 events); tool name `read_file` and arguments `{"path":"README.md"}` were assembled from the stream on all three; usage was 1000 input / 200 output on every request (streamed and not).

LiteLLM `mock_response` rows (a): `/chat/completions` works for text and streaming, but no tool call; `/v1/messages` returns JSON when `stream: true`; `/v1/responses` with `stream: true` returns 500; usage is estimated. These are mock limits, not transport defects, and the Messages route against it priced at 0 (see Q6).

NOT TESTED: real Anthropic, OpenAI and OpenRouter upstreams, and Bedrock Claude (no key or call, by decision). `/v1/messages` against an OpenAI-protocol upstream also worked (LiteLLM translated), but it is not an offered combination.

## Question 5: Bedrock in another account (documentation and parameter confirmed; live denial NEEDS HUMAN)

- The IAM service authorization reference for STS (machine-readable form, `servicereference.us-east-1.amazonaws.com/v1/sts/sts.json`) lists `sts:ExternalId` among the condition keys of `sts:AssumeRole` (resource type `role`). The IAM global condition keys page says `aws:ResourceAccount` is "always included in the request context for most service actions" and lists its exceptions; `sts:AssumeRole` is not among them. Its example is an identity-based policy.
- LiteLLM has the parameter: `aws_external_id` (source `llms/bedrock/base_aws_llm.py` passes it as `ExternalId` to `AssumeRole`; the env fallback is `AWS_EXTERNAL_ID`). It is one of the body parameters the proxy refuses from clients (Q8). The other identity parameters are `aws_role_name` and `aws_session_name`.
- Supplementary, not live: `iam simulate-custom-policy` (a read-only evaluation, no resource created) on profile `agentx-test` with an Allow on `arn:aws:iam::*:role/*` plus a Deny when `aws:ResourceAccount` equals the own account: a same-account role gave `explicitDeny`, another account's role `allowed`. With `StringLike sts:ExternalId = rovara-org_*`: `rovara-org_abc` allowed, `other` and an absent external id `implicitDeny`.
- **NEEDS HUMAN:** "assuming a same-account role is denied live" needs a real IAM role (and the proxy task role's policy) in an AWS account. PF29 forbids creating one without the human. Until it passes, `bedrock` stays out of `SOURCE_KINDS_AT_LAUNCH`. If the human approves, record which role was used.

## Question 6: prices (GO)

Per-token prices from Pi's catalog (installed `@earendil-works/pi-ai`): `claude-sonnet-4-6` 3 / 15 USD per million (input / output), `gpt-5` (`openai-responses`) 1.25 / 10, `openrouter openai/gpt-5` (`openai-completions`) 1.25 / 10. Set as `input_cost_per_token` and `output_cost_per_token` in `litellm_params` on each alias. With 1000 input and 200 output tokens per request, a key's spend after 4 requests (text, streamed, tool, streamed tool) equalled list price exactly on every route and upstream: 0.024 on Messages (4 x 0.006), 0.013 on Responses and Completions (4 x 0.00325), for both the wire mock and the second LiteLLM. Streamed requests are priced. NOT TESTED: cache read and write tokens; the `mock_response` rows (spend 0 on Messages, estimated tokens on the others); a vendor's real usage.

## Question 7: health per alias (GO)

`GET /health?model=<alias>` (or `?model_id=<id>`) with the master key. Healthy body: `{"healthy_endpoints":[{"api_base":"...","model":"openai/gpt-mock","model_id":"..."}],"unhealthy_endpoints":[],"healthy_count":1,"unhealthy_count":0}`. A dead upstream returns an `unhealthy_endpoints` entry with `api_base`, `model`, `model_id`, `exception_status`, a full Python stack trace in `error`, and `raw_request_typed_dict` with the request body and a masked `Authorization` (`Be****yz`: the first two and last two characters of the secret). The check makes a real upstream call (the mock logged a chat request) and took about 1.5 s for a refused connection. An alias the replica has not synced yet returns `healthy_count: 0` and `unhealthy_count: 0` (unknown, not unhealthy). An org key may call `/health?model=<own alias>` (no `api_base` in the body) and gets 403 for another alias. Rovara should map the response to healthy, unhealthy or unknown and never show the body to members.

## Question 8: client-side overrides (NO-GO stock; fix verified)

- Refused (HTTP 401, "Rejected Request: <param> is not allowed in request body") on all three routes, nothing reached the upstream or the canary: `api_base`, `base_url`, `aws_role_name`, `aws_external_id`, `user_config`.
- **Not refused:** `api_key` (HTTP 200; the upstream received the client's key instead of the deployment's) and `extra_headers` (HTTP 200; the upstream received the client's header and the client's `Authorization` replaced the deployment's). Neither is in `_BANNED_REQUEST_BODY_PARAMS`.
- `configurable_clientside_auth_params` default: `null` (visible in `/model_group/info`); `general_settings.allow_client_side_credentials` is unset (false). With both unset, the banned list above is enforced unconditionally; the list is a fixed tuple in the pinned image and cannot be extended by config.
- Fix verified: a config-embedded `CustomLogger` whose `async_pre_call_hook` raises HTTP 400 when the body carries `api_key`, `extra_headers`, `headers`, `extra_body`, `litellm_credential_name`, `timeout`, `ssl_verify`, `api_version` or `custom_llm_provider`. With it, clean requests returned 200 and all six override requests (two per route) returned 400 and never reached the upstream. It needs a `custom_hook.py` next to the config (`litellm_settings: callbacks: custom_hook.proxy_handler_instance`); the ECS task writes only the YAML today, so the start command must also write the file.
- Gate: `endpoint` also needs Q9, so it stays out regardless.

## Question 9: redirects (NO-GO)

Models whose `api_base` pointed at a route answering 3xx. Every transport followed the redirect: HTTP 302, 307 and 308 to an `http:` canary reached the canary on `/chat/completions`, `/v1/responses` and `/v1/messages` (stream and non-stream); a 302 to `http://169.254.169.254/latest/meta-data/` was followed (errors: "Cannot connect to host 169.254.169.254:80"); an `https:` upstream redirecting to `http:` was followed on `/v1/responses`. The canary's response body appears in the client-visible error (`OpenAIException - {"ok": true, "canary": true}`), so a redirect is an SSRF with a reflected body. The source hard-codes `follow_redirects=True` in the OpenAI and shared httpx clients (`llms/openai/common_utils.py`, `llms/custom_httpx/http_handler.py`); there is no configuration switch. `endpoint` stays out until the proxy is isolated by the network (egress only to the validated host, nothing link-local or task-metadata reachable) and that is itself tested, or LiteLLM is changed.

## Question 10: `ssl_verify` (GO, fail closed)

Against the self-signed HTTPS mock: `ssl_verify: true` and an absent `ssl_verify` fail with a certificate error on all three transports (HTTP 500, nothing reached the upstream). Caveats: `ssl_verify: false` and a CA bundle path (`/spike-ca/cert.pem`) are honoured only by `/v1/responses`; `/chat/completions` and `/v1/messages` ignore both and keep verifying with the system store. So per-model TLS verification cannot be turned off through the model (good), a private CA cannot be supplied per model on Completions or Messages (so private-CA endpoints are unsupported at launch), and the setting is "consulted" only on Responses.

## Question 11: spend lag (GO): `FINALIZE_DELAY_MS = 120000`

- `/key/info` spend after one request: 0.5 s, 9.6 s and 9.4 s (identical on both replicas); after a burst of 80 requests over both replicas, the full spend (0.26) was visible 9.2 s after the last response. The flush interval is `PROXY_BATCH_WRITE_AT` (default 10 s). Spend-log rows were visible within about 4 s. The default of 120000 ms keeps a margin of more than 10 times.
- After `/key/block`, `/key/info` still returns the key with `blocked: true` and the full spend. After `/key/delete`, `/key/info?key=<key>` still returned the full info and spend, and `/spend/logs?api_key=<hashed token>` returned all 80 rows (sum 0.26); `/key/list?include_deleted=true` did not list it.
- Revocation lag across replicas: the replica that took `/key/block` or `/key/delete` refuses at once (401), the other replica kept accepting the key for 60 s (60.1 s and 60.0 s) because of the key cache. Revoking a key is complete only after about 60 s. A blocked key was still served on the other replica in the earlier burst test for the same reason.

## Question 12: key `metadata` in spend logs (NO-GO)

A key generated with `metadata: {"orgId": "org_q12", "memberId": "m_q12", "taskId": "t_q12"}` produced spend-log rows (`/spend/logs`) that contain none of those values (`metadata.user_api_key_auth_metadata` is null). The row has `user_api_key_alias`, `team_id`, hashed `api_key`, `model_group`, `model`, `spend`, token counts and `request_tags` (user agent only). Key `tags` cannot be used: `/key/generate` with `tags` returns 403 "only available for LiteLLM Enterprise users". So Task 30 tags ledger lines from `ModelKeyRecord.tags`, joining on the hashed key (or `user_api_key_alias`).

## NOT TESTED

- Real OpenAI, Anthropic, OpenRouter upstreams and Bedrock (any account): streaming, tool calls, usage and prices against a vendor.
- Secrets Manager against real AWS (a throwaway secret is an AWS resource) and credential rotation through a Secrets Manager reference.
- Q5's live same-account denial (needs an IAM role).
- Cache token prices, reasoning tokens, concurrency races at a budget boundary.
- A fix for Q9 (network isolation) and the effect of the Q8 hook on Pi's real request bodies (Pi may set fields the hook bans, for example `timeout`; trim the list against Pi's actual bodies before adopting it).

## Notes for the plan

- Tell the human before Task 24 only if they want kinds enabled sooner: 1 and 2 are GO, so Task 24 is not blocked.
- Task 25 (proxy infrastructure): load balancer allow-list of `INFERENCE_PATHS` (and the existing health path), the pre-call hook file, a shared `LITELLM_SALT_KEY` secret, `STORE_MODEL_IN_DB=True` (the production task currently sets it to `False`).
- Key lifecycle: minting always sets `models` and `team_id`; expect up to 60 s to revoke on every replica and up to about 30 s for a deleted alias.
