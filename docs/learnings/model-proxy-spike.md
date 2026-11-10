# Model proxy spike: LiteLLM with Pi and budgets (Task 9)

Date: 2026-10-19. Throwaway spike; the scripts, compose-equivalent and config lived in the session scratchpad and are not merged. Only these findings are.

## Setup

- LiteLLM image: `ghcr.io/berriai/litellm-database:v1.105.1`, digest `sha256:2bcadb9905b692a5ca4dadd51bccaaa23a95dc8a0f9322d9c9787f0ac2aeb50e` (proxy reports `x-litellm-version: 1.105.1`). Latest stable at the time was v1.106.0 (one day old); v1.105.1 was chosen for age.
- Postgres: `postgres:16`, 16.15 (Debian 16.15-1.pgdg13+2), digest `sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.
- Docker on colima (default profile). The `docker compose` plugin is not installed on this machine, so the stack was started with plain `docker run` on a user network (same shape as a compose file: db + proxy, proxy bound to `127.0.0.1:4000`, Postgres unpublished).
- Real model calls only to Claude on Amazon Bedrock, AWS profile `agentx-test`, us-east-1, via `~/.aws` mounted read-only into the proxy container with `AWS_PROFILE=agentx-test AWS_REGION=us-east-1`. Credentials were never read, exported or printed. 5 real requests in total (max_tokens <= 256).
- No OpenAI or other provider keys (human's choice). A `mock_response` model stands in for GPT.
- Bedrock model id: Rovara's `DEFAULT_BEDROCK_MODELS` is `us.anthropic.claude-sonnet-4-6` (packages/model-runtime/src/config.ts), used as `bedrock/us.anthropic.claude-sonnet-4-6`.

`config.yaml` (essentials; the master key and virtual keys are throwaway, generated locally, not recorded here):

```yaml
model_list:
  - model_name: claude-sonnet-4-6        # also aliased as claude-sonnet
    litellm_params: { model: bedrock/us.anthropic.claude-sonnet-4-6, aws_region_name: us-east-1 }
  - model_name: gpt                      # mock stand-in for GPT
    litellm_params:
      model: openai/mock-gpt
      api_key: not-a-real-key
      mock_response: "Mock GPT reply for budget testing."
      input_cost_per_token: 0.0003
      output_cost_per_token: 0.0006
    model_info: { input_cost_per_token: 0.0003, output_cost_per_token: 0.0006 }
general_settings: { master_key: os.environ/LITELLM_MASTER_KEY, database_url: os.environ/DATABASE_URL }
```

## Commands run (secrets redacted)

```sh
colima start
docker pull ghcr.io/berriai/litellm-database:v1.105.1 ; docker pull postgres:16
docker network create litellm-spike-net ; docker volume create litellm-spike-pgdata
docker run -d --name litellm-spike-db --network litellm-spike-net --network-alias db \
  -e POSTGRES_USER=litellm -e POSTGRES_PASSWORD=<generated> -e POSTGRES_DB=litellm \
  -v litellm-spike-pgdata:/var/lib/postgresql/data postgres:16
docker create --name litellm-spike-proxy --network litellm-spike-net -p 127.0.0.1:4000:4000 \
  -e LITELLM_MASTER_KEY=<MASTER_KEY> -e DATABASE_URL=postgresql://litellm:<generated>@db:5432/litellm \
  -e STORE_MODEL_IN_DB=False -e PROXY_BUDGET_RESCHEDULER_MIN_TIME=5 -e PROXY_BUDGET_RESCHEDULER_MAX_TIME=8 \
  -e AWS_PROFILE=agentx-test -e AWS_REGION=us-east-1 -e AWS_DEFAULT_REGION=us-east-1 -e AWS_REGION_NAME=us-east-1 \
  -v $HOME/.aws:/root/.aws:ro \
  ghcr.io/berriai/litellm-database@sha256:2bcadb99... --config /app/config.yaml --port 4000
docker cp config.yaml litellm-spike-proxy:/app/config.yaml ; docker start litellm-spike-proxy
# (colima does not share /private/tmp into the VM, so the config is copied in, not bind-mounted)

curl -X POST :4000/team/new     -H "Authorization: Bearer <MASTER_KEY>" -d '{"team_id":"spike-team-t","max_budget":0.05,"budget_duration":"1mo"}'
curl -X POST :4000/user/new     -H "Authorization: Bearer <MASTER_KEY>" -d '{"user_id":"spike-user-u","max_budget":0.05,"budget_duration":"1mo"}'
curl -X POST :4000/key/generate -H "Authorization: Bearer <MASTER_KEY>" \
  -d '{"team_id":"spike-team-t","user_id":"spike-user-u","max_budget":5,"duration":"30d","budget_duration":"1mo",
       "metadata":{"orgId":"org_x","memberId":"m_1","taskId":"t_1"},"models":["gpt","claude-sonnet"],"key_alias":"spike-full"}'
# three single-purpose keys: key budget only (max_budget 0.05), user only (user_id), team only (team_id)
# each driven with the mock model until the first non-200:
curl :4000/v1/chat/completions -H "Authorization: Bearer <VIRTUAL_KEY>" -d '{"model":"gpt","max_tokens":16,"messages":[...]}'
# reset: psql UPDATE "LiteLLM_TeamTable"/"LiteLLM_UserTable" SET budget_reset_at = now() - interval '1 minute'
# Pi driver (Node 22): npx tsc -b ; node pi-spike.mjs {text|tools|baseurl|error} <key var> <model id>
docker rm -f litellm-spike-proxy litellm-spike-db ; docker volume rm litellm-spike-pgdata ; docker network rm litellm-spike-net ; colima stop
```

The first Bedrock attempt failed with "Your session has expired" because the `agentx-test` `aws login` session had lapsed; the human re-authenticated and the proxy was restarted. That also showed the read-only `~/.aws` mount is picked up by LiteLLM's botocore (it resolves `login_session` profiles).

## Question 1: Pi anthropic-messages through LiteLLM

Transport that worked: Pi `api: "anthropic-messages"` with LiteLLM's Anthropic-compatible endpoint. Pi's Anthropic client posts to `{baseUrl}/v1/messages?beta=true`, so the baseUrl is the proxy origin without a path: `http://127.0.0.1:4000` (production: the proxy's internal origin). Auth is the virtual key as `x-api-key` (Pi's `setRuntimeApiKey` / `readProviderKey` path, unchanged). The model name sent is Pi's catalog id (`claude-sonnet-4-6`), so LiteLLM needs a `model_name` with that exact value. `/chat/completions` was not needed for Claude and was not used with Pi.

Two ways of pointing Pi at the proxy were run, both for `claude-sonnet-4-6` on Bedrock, 1 real request each unless noted:

1. `createConfiguredModelRuntime({provider:"anthropic", modelId:"claude-sonnet-4-6"}, {readSecret, fetch, onUsage})` with Pi's fixed origin `https://api.anthropic.com` rewritten to the proxy inside the injected `fetch`. The runtime has no baseUrl override today (`TRANSPORTS` hard-codes it; Task 12 adds one), so this is how the unmodified runtime was driven.
2. `runtime.registerProvider("litellm", {baseUrl: "http://127.0.0.1:4000", api: "anthropic-messages", models: [...]})` plus `setRuntimeApiKey("litellm", <virtual key>)`: works with no fetch rewrite; the request landed at the proxy (confirmed in the proxy's spend log). This is the shape Task 12 should implement.

Results (Claude via Bedrock):

- Streamed text: LiteLLM answered `text/event-stream`. Pi saw `start, text_start, text_delta x9, text_end, done`; first delta about 1.0 s, total about 1.2 s; `stopReason: "stop"`.
- Tool call round trip: turn 1 streamed `toolcall_start, toolcall_delta x4, toolcall_end, done` with `stopReason: "toolUse"` and arguments `{"path":"README.md"}` assembled correctly. Turn 2 (assistant tool call plus `toolResult` sent back) returned text with `stopReason: "stop"` and the tool result was used in the answer. 2 real requests.
- GPT via OpenAI: **NOT TESTED** (no OpenAI key, by the human's choice). The mock model cannot exercise it either: with `mock_response`, `stream: true` on `/v1/messages` returns a plain JSON message rather than SSE, and tool calls were not attempted with it. Note that Pi's OpenAI transport is `openai-responses` (`TRANSPORTS.openai`), so the GPT half needs LiteLLM's `/v1/responses` (not `/v1/messages`) and must be verified separately before relying on GPT through the proxy.

## Question 2: usage and cost in onUsage

- Tokens: input and output counts from the stream reached Pi's `onUsage` and matched LiteLLM's own spend log exactly (for example 570 in / 56 out on the tool turn in both). Final record, text scenario: `{"event":"model_request_usage","provider":"anthropic","requestedModel":"claude-sonnet-4-6","returnedModel":"claude-sonnet-4-6","tokens":{"input":16,"output":20,"cacheRead":0,"cacheWrite":0},"costUsd":0.000348,"costSource":"list-price","outcome":"stop"}`. The tool-call turn reported `outcome: "toolUse"`.
- Cost does NOT come from LiteLLM. Pi computes `costUsd` itself from its catalog list price, so `costSource` is `"list-price"`. LiteLLM's real cost is not in the Anthropic response body, and for streamed responses the `x-litellm-response-cost` header is absent (headers are sent before the cost is known). On non-streamed responses the header is present (e.g. `x-litellm-response-cost: 0.0002475`).
- LiteLLM bills this model about 10 percent above Pi's list price (cross-region inference profile price in LiteLLM's cost map: 3.3 / 16.5 USD per million tokens versus Pi's 3 / 15). Same tokens, spend log vs Pi: 0.0003828 vs 0.000348 (text), 0.002805 vs 0.00255 (tool turn 1), 0.0026565 vs 0.002415 (turn 2). Budgets are enforced on LiteLLM's number, so Rovara's own ledger/UI should read spend from LiteLLM (`/key/info`, `/team/info`, `/user/info`, spend logs) or accept a systematic 10 percent skew against `onUsage.costUsd`.
- Cache tokens: the `cacheRead`/`cacheWrite` fields are carried through (all 0 here, since no prompt caching was requested). A cache hit or write was NOT TESTED (needs a prompt of at least 1024 tokens sent twice; kept within the request limit). LiteLLM logs a warning that custom-priced models default cache costs to 0; real Bedrock Claude models are in its cost map.
- LiteLLM spend and metadata do attribute per request: the spend log rows carry the key alias and the key's metadata (`orgId`, `memberId`, `taskId` were stored on the key and returned by `/key/info`).

## Question 3: budgets block requests; month reset

Method: team, user and key budgets of 0.05 USD exercised separately with the mock model priced 0.0003 / 0.0006 USD per token (spend accrues only on `/v1/chat/completions` for the mock, see caveats), each driven until the first non-200. Each blocked on the 5th request after 4 successful ones (the check is spend-so-far versus max, so the request that crosses the line is allowed and the next one is refused). The refusal is HTTP **422** with `type: "budget_exceeded"`, in an OpenAI-style error envelope (not Anthropic's `{"type":"error",...}`), and identical on `/v1/chat/completions` and `/v1/messages`.

Exact bodies (HTTP 422, `Content-Type: application/json`):

Key budget:

```json
{"error":{"message":"Budget has been exceeded! Key=spike-key-budget (sk-...<redacted>) Current cost: 0.06170999999999999, Max budget: 0.05","type":"budget_exceeded","param":null,"code":"422"}}
```

User budget:

```json
{"error":{"message":"ExceededBudget: User=spike-user-u over budget. Spend=0.06119999999999999, Budget=0.05","type":"budget_exceeded","param":null,"code":"422"}}
```

Team budget:

```json
{"error":{"message":"Budget has been exceeded! Team=spike-team-t Current cost: 0.06119999999999999, Max budget: 0.05","type":"budget_exceeded","param":null,"code":"422"}}
```

All three share `type: "budget_exceeded"` and `code: "422"`; they are told apart only by the message text: prefix `Budget has been exceeded! Key=`, `ExceededBudget: User=`, or `Budget has been exceeded! Team=`. Task 16 (runtime recognition in `safeProviderStream` / `ModelBudgetExhaustedError`) must match on that text (the team and key bodies share the same lead-in, so match `Team=` / `Key=`).

Calendar-month reset: `budget_duration: "1mo"` gives `budget_reset_at` = the 1st of the next month at 00:00:00Z for a team, a user and a key (observed `2026-11-01T00:00:00Z` when created on 2026-10-19). The reset timezone is UTC unless `litellm_settings.timezone` is set; the time of day is midnight unless `budget_reset_time` is set. The source (`duration_parser._handle_month_reset`) rolls to the 1st of next month if the 1st of this month has passed. In v1.105.1 `"30d"` is special-cased to the same monthly rule (`_handle_day_reset`: value 30 delegates to month reset), so it also gave `2026-11-01T00:00:00Z`, but that is an undocumented special case; use **`"1mo"`**. Only 1 month is supported (`"2mo"` raises); `"1M"` and similar are rejected with HTTP 400 `Invalid budget_duration 'X'. Use a format like '1h', '24h', '7d', or '30d'.` Other `Nd` values (not 1, 7, 30) are N days from today's midnight, not calendar aligned.

Reset job exercised: with the rescheduler interval set to 5 to 8 seconds, `budget_reset_at` for the exhausted team and user was moved into the past in Postgres; within about 25 s spend returned to 0, the previously blocked keys succeeded again, and `budget_reset_at` re-armed to `2026-11-01T00:00:00Z`. The default rescheduler interval is about 10 minutes, so a real reset can lag the 1st by up to about that long (spend continues to be blocked until the job runs). Rovara should not assume sub-minute precision at the month boundary.

## Question 4: /key/generate parameters

Accepted and honoured: `team_id`, `user_id`, `max_budget`, `duration` (`"30d"` became an `expires` timestamp 30 days out; the response shows `duration: null` and `expires` set), `budget_duration` (`"1mo"`, key reset_at 2026-11-01), `metadata` (an arbitrary object, echoed in the response and in `/key/info`), plus `models` and `key_alias`. Team and user must exist beforehand (created with `/team/new` and `/user/new`, which accept `max_budget` and `budget_duration`; `/user/new` also returns a key). A key with `team_id` and `user_id` and its own `max_budget` is checked against all of them; any one over its limit returns the matching 422 above.

## Caveats and facts for Tasks 10 to 16

- Task 16 (runtime) and Task 15 (start-time): Pi cannot see the budget error today. `safeError` in `packages/model-runtime/src/index.ts` discards the response body and has no 422 branch, so an exhausted key surfaces as the generic "Anthropic request failed; check credentials, model availability, rate limits and provider status" and `onUsage` reports `costSource: "unknown"`, `outcome: "error"`. Pi made one request and did not retry (the 422 is final). Runtime recognition of the 422 body belongs to Task 16 (`safeProviderStream` / `ModelBudgetExhaustedError`): read the body in `observedFetch` (it already clones responses) for `type: "budget_exceeded"`, classify by message text (`Team=` for the organisation, `Key=` or `User=` for the member), and add a 422 case to `safeError` without echoing the body. The start-time `BUDGET_EXCEEDED` / `ORG_BUDGET_EXCEEDED` 402 codes are Task 15's.
- Caps are soft. LiteLLM checks spend-so-far against the cap before a request, so the request that crosses the line is allowed (observed: spend 0.0617 against a 0.05 cap, and 0.0612 for user and team), and concurrent in-flight requests can overshoot further (not measured). Task 15 must clamp remaining budget at 0 (never show or compute a negative remainder) and must not promise exact caps to members or organisations.
  - 0.5.13 (2026-11-10, replaces the overshoot part for task keys): the guard now holds each call's worst case in a ledger in LiteLLM's Postgres that both replicas share, before the call is forwarded, and settles it to the real cost; a cut stream is charged its whole hold; a call that only other calls' holds block gets 429 `budget_held` (the worker waits it out). LiteLLM v1.105.1's own optimistic reservation is turned off (`disable_budget_reservation: true`): without Redis it is per replica, and it answers a held budget with 422 `budget_exceeded`, which ends the task. Org and member (team and user) budgets stay LiteLLM's read-time check; the broker splits their room into task keys at mint. Evidence: `rovara_guard.py` section 4, `tests/integration/model-proxy-budget-docker.test.ts` (real LiteLLM, two replicas) and the design note CLOUD-MODEL-BUDGET-RESERVE.md.
- The runtime has no baseUrl override yet (expected, Task 12); use `registerProvider` with `api: "anthropic-messages"` and the proxy origin as the baseUrl.
- LiteLLM spend is written to Postgres in batches; the in-memory counters used by the budget check are current. `/key/info` lagged by a few seconds right after requests.
- Mock model artefacts (not LiteLLM defects): cost is `$0` on `/v1/messages` for a `mock_response` model ("priced at $0, pricing_not_applied"); cost accrues on `/v1/chat/completions`; `stream: true` returns non-streamed JSON. Mock budgets were therefore exhausted on `/v1/chat/completions`. The budget gate is route independent (an exhausted key got the same 422 on `/v1/messages`). Real Claude cost accrues on `/v1/messages` (confirmed: key spend 0.0064251 after the five real requests).
- Pricing for the mock was first set in `model_info` only (as the brief asked) and cost stayed `$0` on `/v1/messages`; it was then set in both `litellm_params` and `model_info`, after which `/v1/chat/completions` priced correctly. Whether `model_info` alone suffices on `/v1/chat/completions` was not isolated.

## Ruling R21 (amended): what the proxy serves at launch

- At launch the proxy serves Claude models only. The spike verified only Bedrock-served Claude; Anthropic-direct Claude is NOT TESTED.
- LiteLLM `model_name` aliases must equal Pi's catalog ids exactly, because Pi sends the catalog id as the request `model`. Pi's `amazon-bedrock` catalog ids include the inference-profile forms, so the Bedrock default is `us.anthropic.claude-sonnet-4-6` and the classifier default is `us.anthropic.claude-haiku-4-5-20251001-v1:0` (`DEFAULT_BEDROCK_MODELS`).
- Bedrock provider mapping Task 10 must emit: for each served Bedrock model, a `model_list` entry `model_name: <Pi catalog id>` (for example `us.anthropic.claude-sonnet-4-6`) with `litellm_params.model: bedrock/<the same id>` and `aws_region_name`. The Pi side must register the provider with `api: "anthropic-messages"` (overriding the catalog's native `bedrock-converse-stream`) and `baseUrl` = the proxy origin, with the virtual key as the API key. The spike ran this transport with the Anthropic catalog id `claude-sonnet-4-6` aliased to `bedrock/us.anthropic.claude-sonnet-4-6`; a `us.`-prefixed `model_name` under the overridden api is the same LiteLLM path but was not itself run (NOT TESTED below). Anthropic direct models (`anthropic/<id>` with an Anthropic key) were not run either.
- OpenAI (`openai-responses` to `/v1/responses`) and OpenRouter (`openai-completions` to `/chat/completions`) are NOT routed through the proxy until a follow-up spike verifies them.
- The ChatGPT plan path stays direct (its token and fallback logic is not proxied).

## NOT TESTED

- GPT via OpenAI (no key, human's choice); Pi's OpenAI transport is `openai-responses`, a different LiteLLM route than `/v1/messages`.
- Streaming and tool calls for any model other than Claude on Bedrock.
- Prompt-cache read and write token counts and their cost (no cache-eligible prompt sent).
- Extended thinking / reasoning blocks through the proxy.
- A `us.`-prefixed `model_name` with Pi's api overridden to `anthropic-messages` (the spike used the alias `claude-sonnet-4-6`), and Anthropic direct models.
- Seconds-based key `duration` (`"<ttl>s"`); only `"30d"` was run.
- OpenAI `/v1/responses` and OpenRouter `/chat/completions` through the proxy (see R21).
- Concurrent requests racing a budget boundary (overspend by in-flight requests is therefore not measured).
- The default reset-job cadence (a forced reset was tested with a shortened interval).
- Production hosting concerns (ECS, Secrets Manager resolution, IAM): out of scope for the spike.

## Decision rationale

GO covers ONLY Claude through Pi `anthropic-messages` to LiteLLM `/v1/messages` (Bedrock-served), under ruling R21 above. Verified for that path: text and tool calls stream correctly; usage tokens come back to `onUsage` and match LiteLLM's ledger; key, user and team `max_budget` each block with a recognisable HTTP 422 `budget_exceeded` body; `/key/generate` takes `team_id`, `user_id`, `max_budget`, `duration` and `metadata`; `budget_duration: "1mo"` resets on the 1st of each month UTC. Not covered by this decision: GPT/OpenAI, OpenRouter, ChatGPT-plan, prompt caching, reasoning blocks. The known caveats are not blockers: the 10 percent price skew is resolved by ruling R22 (LiteLLM spend is authoritative for budgets and usage; Pi's `onUsage` cost is informational), and the soft caps and Pi hiding the budget error body are handled in Tasks 15 and 16.

Decision: GO

## Final fix wave: what staging must verify (rulings R48 and R52)

- Network layers (R48): the load balancer's port 4000 forwards `/v1/messages*` and `/health/*` only and answers everything else with a fixed 403; port 4001 forwards every path and admits the ModelAccessFunction's security group alone. T20 must prove a task key gets 401/403 on `/key/generate`, `/user/new` and `/team/info` from a worker on port 4000, that a worker cannot connect to port 4001, and that `allowed_routes: ["llm_api_routes"]` still lets the key call `/v1/messages` (and its count_tokens route).
- Users are created with `user_role: "internal_user_viewer"`; T20 should confirm LiteLLM accepts that value on `/user/new` and `/user/update`.
- Geography (R52): the proxy serves the install region's inference profiles (us-* gives `us.*`, eu-* `eu.*`, ap-* `apac.*`); any other region fails the synth. A deploy or upgrade whose orchestrator, classifier or worker is not a Bedrock Claude model of that geography is refused before anything deploys, so release notes must say that OpenRouter, Anthropic-direct and OpenAI model choices are not available on named installs until their routes are verified.
- `LITELLM_LOCAL_MODEL_COST_MAP=True` makes LiteLLM read prices from the image instead of fetching them at start.
