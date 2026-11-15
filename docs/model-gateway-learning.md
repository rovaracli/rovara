# Model gateway: the learning route

DEC 226 (learning calls on the customer's own account, $20 a month per company, none while lessons are off), DEC 228c (one
combined company cap). Code: `packages/model-gateway/src/learning-route.ts`; `startServe` mounts it when given `learning`
(the company's key source and the learning meter). The deployed process builds it when `GATEWAY_LEARNING_*_TABLE` are set
(with the product route, whose key store holds the company's account; docs/model-gateway-product-ai.md "Deployed").

## What it is

A third route on the same gateway for lessons' learning calls: the reflector, the curator's judge and the outcome judge
(Code: `packages/broker/src/lessons`, the `learning` model-access port of `core-host/lessons.ts`, #684).

| | Agent route (`POST /v1/messages`) | Learning route (`POST /v1/learning/messages`) |
|---|---|---|
| Token | TC-1 task token, any step except the learning step | the same TC-1 token with `stp` = `rovara-lessons-learning-call` (`LEARNING_STEP`) |
| Key | the gateway's install key | the company's OWN connected provider account (`LearningKeySource`), never the install key |
| Stop | the task-ended record | the company's lessons switch, read on every call before anything else |
| Meter | agent meter | its own meter (separate tables), combined with the agent meter's company row |
| Caps | task, person, project, company | the learning month row: min($20, company monthly cap); plus the combined company cap |
| Who pays | the token's payer items | the company (no person item; task and project rows are accounting only) |
| Body | Anthropic Messages | Anthropic Messages (the same request guard and price resolver) |

Learning spend lives in the SAME combined company row and the SAME one-overrun-call-in-flight marker as agent and product
spend (#56, DEC 228c): there is no third company cap. `startServe` refuses a learning meter that does not combine, that
combines with tables other than this gateway's agent tables, or whose own tables are the agent's or the product meter's.

The money core (worst-case hold, settle once, not-sent faults free, post-send faults charged in full, the
one-overrun-call-per-company marker, deadlines, the secret scanner) is the shared `server.ts` code.

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

- Built: `learning-keys.ts` reads the company's own Anthropic account from the product key store (a company source of provider
  `anthropic`, sealed like the product keys; never a project's, never linked), and the learning meter's tables and grants are in
  `lib/model-gateway.ts` behind the product switch. Not built: a Cloud settings route for a company admin to connect it.
- A per-company learning ceiling setting (the ceiling is one install-wide value, default $20).
- Providers other than Anthropic Messages for learning calls.
