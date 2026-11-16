# Model gateway: the learning route

DEC 226 (learning calls on the customer's own account, $20 a month per company by default and set per company in the company settings, none while lessons are off), DEC 228c (one
combined company cap). Code: `packages/model-gateway/src/learning-route.ts`; `startServe` mounts it when given `learning`
(the company's key source and the learning meter). The deployed process builds it when `GATEWAY_LEARNING_*_TABLE` are set
(with the product route, whose key store holds the company's account; docs/model-gateway-product-ai.md "Deployed").

## What it is

A third route on the same gateway for lessons' learning calls: the reflector, the curator's judge and the outcome judge
(Code: `packages/broker/src/lessons`, the `learning` model-access port of `core-host/lessons.ts`, #684).

| | Agent route (`POST /v1/messages`) | Learning route (`POST /v1/learning/messages`) |
|---|---|---|
| Token | TC-1 task token, any step except the learning step | the same TC-1 token with `stp` = `rovara-lessons-learning-call` (`LEARNING_STEP`) |
| Key | the gateway's install key; in company-key mode (`GATEWAY_AGENT_KEYS=company`, DEC 236) the same company account as learning, never the install key | the company's OWN connected provider account (`LearningKeySource`), never the install key |
| Stop | the task-ended record | the company's lessons switch, read on every call before anything else |
| Meter | agent meter | its own meter (separate tables), combined with the agent meter's company row |
| Caps | task, person, project, company | the learning month row: min(the company's learning cap, company monthly cap); plus the combined company cap |
| Who pays | the token's payer items | the company (no person item; task and project rows are accounting only) |
| Body | Anthropic Messages | the company's connected provider's own shape: Anthropic Messages, Gemini (AI Studio or Vertex) or OpenAI Chat Completions (see "Providers") |

Learning spend lives in the SAME combined company row and the SAME one-overrun-call-in-flight marker as agent and product
spend (#56, DEC 228c): there is no third company cap. `startServe` refuses a learning meter that does not combine, that
combines with tables other than this gateway's agent tables, or whose own tables are the agent's or the product meter's.

The money core (worst-case hold, settle once, not-sent faults free, post-send faults charged in full, the
one-overrun-call-per-company marker, deadlines, the secret scanner) is the shared `server.ts` code.

## The company's learning cap

`settings.budgets.learningMonthlyUsdMicros` in the company backend's settings (cloud-server `company-settings.ts`): whole
micro-dollars, never null, **default $20** (`LEARNING_DEFAULT_MONTHLY_USD_MICROS`), and never above the company's monthly cap
(the backend refuses a document that does; a document or stored row without the field reads as $20 held under the company cap,
so older rows and the older app keep working). Raising it is a loosening change, so it needs a second admin like every other
cap; lowering it does not. The admin screen lowers it with the company cap. The gateway reads it with the budgets
(`CompanyBudgetCaps`, `Caps.learningMonth`; absent in an older row means the route's own default ceiling) and the learning
route holds the learning month row at `min(learning cap, company monthly cap)`; the combined company cap still holds on top.
A learning cap of $0 pauses learning with `no_budget`. The two code bases keep the field name and the $20 in step through
`tests/contract/model-gateway-company-budgets.test.ts`.

## Providers

The company may connect Anthropic, Gemini (AI Studio), Gemini on Vertex or OpenAI. One route object serves all of them, so the
money core, the learning meter, the combined cap, the pause codes, the switch and the secret scanner are the same code; only
the body guard, the usage reader, the transport and the price rows differ (`LearningProvider`). The smallest generic design:
one path per provider under `/v1/learning/`, the same shapes the provider's own SDK sends, rather than a translation layer
that would turn one wire format into another (a translator is where costs go wrong).

| Path | Provider | Guard, usage, transport | Price rows |
|---|---|---|---|
| `POST /v1/learning/messages` | Anthropic | the agent route's guard and usage | anthropic |
| `POST /v1/learning/gemini/{v1\|v1beta}/models/{model}:{generateContent\|streamGenerateContent?alt=sse}` | Gemini, AI Studio | the product route's Gemini guard (text only here) and usage | gemini |
| `POST /v1/learning/vertex/{v1\|v1beta1}/projects/{p}/locations/{l}/publishers/google/models/{model}:...` | Gemini on Vertex | the Vertex guard; the project and location must be the company's connected ones | the dearer of gemini and vertex |
| `POST /v1/learning/openai/chat/completions` | OpenAI | `learning-openai.ts`: text only, one answer, `max_completion_tokens` always set, `include_usage` forced on streams | openai |

A call is admitted only when the company has THAT provider connected (`LearningKeySource.connected(iss, cid, provider)`; another
provider's key is never used on this path) and the token's `mdl` names the model (Code decides which model each learning call
uses; every provider, not only Anthropic). A provider with no transport has no path (404). A provider's 401/403 is free and a
`no_provider` pause (and `LearningKeySource.refused` lets the adapter drop a cached Vertex token); 429 and 529 are free; on
Gemini, Vertex and OpenAI a 400, 404 or 422 is free too (rejected before any generation, as on the product route), and Google's
400 `API_KEY_INVALID` for AI Studio is the same `no_provider` pause as a 401; other failures keep the hold (Anthropic's rule is
unchanged: only 401, 403, 429 and 529 are free). An OpenAI or Gemini stream without usage (or without `[DONE]` / a finish) is charged at its hold, never
at $0. Audio and video, built-in tools and several answers are refused. On Gemini and Vertex, image, PDF and text files by reference
and a cached context are accepted as on the product route: such a call is overrun-capable, runs alone under the company marker
and settles at its actual cost, so one call can pass a cap by up to one context window of input (DEC 165); unlike the product
route the learning route has no per-task block after an overrun.

## Token purpose

A learning token is accepted on the learning route only, and the learning route accepts nothing else. Either mismatch gets
the same fixed 401 as an invalid token, before anything is read, held or sent. The reserved step is longer than Code's
24-character program step ids and is not a workflow mode, so an ordinary task step cannot carry it. No TC-1 claim changes.

## The lessons switch (fail closed)

`CompanyLessonsSwitch` reads `settings.featureGates.lessons` from the Cloud company backend's settings item (the same
Companies row and GetItem permission the budgets already use; `GATEWAY_COMPANY_LESSONS_GATE`). On only when exactly `true`
on this company's own row; no row, no gate, another company's row or any other value is off. The read is strongly
consistent, so an admin's "off" applies to the next call. A failed read answers 503 and sends nothing. Turning a gate on is
a loosening change in the backend, so it waits for the company's decision rules. Why not the policy hook: it would add a
call to Code on every learning call, and the Companies row is already read on that path.

The switch is read twice: at admission, and again just before the provider call (after the body upload and the hold). Off
or unreadable at that second read: the call is not sent, its hold settles at $0, and the answer is `lessons_off` (or 503).
A call already sent when the switch turns off finishes (bounded by its hold). Learning calls are not stopped by the
task-ended record, because reflection runs after its task has ended.

## Refusals Code turns into a lessons pause

`error.type` is `lessons_paused`, `error.message` is fixed words, and the reason is the `x-rovara-lessons-pause` header:

| Reason | Status | When |
|---|---|---|
| `lessons_off` | 403 | the company's lessons switch is off |
| `no_provider` | 403 | no connected provider account, the key gone just before sending ($0), or the provider refused the company's key (401/403, free) |
| `monthly_limit` | 422 | the company's learning month row has no room |
| `no_budget` | 422 | the combined company cap has no room, or the company has no monthly cap |
| `cost_too_high` | 422 | one call of this size is larger than the whole learning month |

Faults are not pauses: an unreadable switch or key source is 503, an unreadable budget is 502, a hold blocked only by other
calls' holds is the usual 429 `budget_held` with `Retry-After`.

`lessons_off` is not one of Code's `LESSONS_PAUSE_CODES` today: Code's adapter maps it (or Code adds it). The Cloud switch
is separate from Code's own `ROVARA_CORE_LESSONS`: a company needs both on.

## Not built here

- Built: `learning-keys.ts` reads the company's own learning account for each provider (Anthropic, OpenAI, Gemini on AI
  Studio) from the product key store's learning document (`LEARNING_OWNER`, sealed like the product keys; never a project's,
  never linked, never a product source; each provider's path answered only by its own account, Vertex learning never), and the
  learning meter's tables and grants are in `lib/model-gateway.ts` behind the product switch. A company admin connects them in
  Cloud under "Learning AI key" (`packages/cloud-server/src/learning-ai-routes.ts`: `GET /v1/app/org/learning-ai`,
  `PUT|DELETE .../key`; fresh step-up, write-only, audited `learning_ai.key.*`), which also shows the learning cap and why
  lessons are paused. A provider 401/403 marks the account (`LearningKeySource.refused`) for that page.
- Egress to `api.openai.com` for the OpenAI path in infra.
- Code: mint learning tokens whose `mdl` names the model of the path it calls, call the provider's path for the company's
  connected provider, and map `lessons_off`.
- Learning calls on Vertex are corrected on the Gemini rows only (as the product route's are).

## Startup checks

`startServe` refuses to start when a wired product or learning meter does not combine with THIS agent meter's tables, shares a
table with the agent meter or with each other, or cannot show its tables at all (a meter that exposes neither `combinedTables()`
nor `ownTables()`, such as an in-memory one, would pass those checks unseen: only a `DynamoMeter`, or a meter that exposes both
views, is accepted).
