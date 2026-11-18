# Cloud model gateway core (R3a/R3c)

This package is an unwired Cloud service core. It implements Anthropic Messages through injected ports and a `node:http` adapter. It is not a deployed service, a Code engine module, or a production money store. TC-1 is pinned by the shared JSON and its SHA-256 test; task signing kids are pinned separately from developer signing kids, and only `rovara_purpose: "task"` JWKs are imported (ADDENDUM-4). Missing, developer or unknown purposes receive the same fixed 401 as an unknown key. The shared constants include `TASK_KEY_PURPOSE` and the JWK member name; 9d must reconcile this new JSON hash with R3b before merge. Sign-in purpose enforcement must deploy before publishing the second key. `src` is optional and reporting-only.

## Money and concurrency (ADDENDUM-3)

`ModelLimitsSource` supplies each model row's own maximum output independently of `PriceSource`. Tests inject model-limit rows; live model limits are not included. The R3c price ports described below are not wired into a deployed service. A missing or malformed limit, or a request above that limit, receives fixed `400 invalid_request` words before any hold or provider call. An omitted `max_tokens` uses the full row maximum. Every provider request carries the applied maximum; the reservation record and settlement event record it.

For known prices and inline text/function input, the hold uses **every byte of the serialized provider request**, plus a 4,096-token allowance when tools are present, multiplied by the highest possible plain input rate, plus the applied maximum output at the highest possible output rate. Long-context bands apply to the hold only when their threshold is below that byte-plus-allowance input bound. Plain requests cannot incur cache writes; cache/media/unbounded requests retain the cautious input/read/write maximum and the company marker. Settlement charges each actual component at its matching effective rate, rounded up once with integer arithmetic; it is never clipped to the hold. Missing cache-write durations use the dearer 5-minute/1-hour tier. Malformed tier details fail the complete response and retain the fault charge.

Unknown prices use the cautious rate, hold a positive estimate and settle actual usage at that rate. Missing/zero usage or a post-send fault retains the full hold. Input that cannot be bounded at the plain input rate (media, remote source/cache fields including cached tool definitions, unknown content kinds) is also overrun-capable, even with a known price. Unknown prices never cause a price refusal. Native fileData/cachedContent routes are not implemented here; when added, their fixed reservations must take this same marker.

Reserve atomically checks task, optional person-month, project-month and company-month: `committed <= cap - estimate`. Overrun-capable reservations additionally acquire one marker keyed by install and company, across all tasks, projects and months. Priced bounded calls do not consult the marker. Competing overrun-capable calls receive `429 busy`, named fixed plain-word text and `Retry-After: 2`; the required metrics port increments the install/company counter and the log port records `overrun_busy` with the company id. Observability faults do not alter money or admission. Production wiring must provide working metric/log adapters; tests use fakes.

The task token authorizes admission only: its `exp` does not stop an admitted call. Each total call deadline starts at handler entry and is sized from the applied output maximum at `CONSERVATIVE_OUTPUT_TOKENS_PER_SECOND = 10`, plus `CALL_STARTUP_ALLOWANCE_MS = 60_000`. `CALL_HARD_CEILING_MS = 3_600_000` (60 minutes) is absolute, including when an injected timeout is larger. A timeout override can only shorten the deadline. Overrun-capable calls have an additional bound of 900 seconds from admission, rounded down to integer seconds, shared by the provider deadline and company marker. The meter's legacy `tokenExpiresSeconds` field receives this admission-lifetime bound; it no longer receives the JWT expiry. The marker expires on read at the earliest of these bounds and 900 seconds after reservation. Expiry releases **only the marker**, never any reserved money. Holds remain until atomic settlement; this lane has no background reaper. Closing an expired owner cannot delete its replacement's marker. A failed settlement keeps its hold; the deadline still frees its marker. Settlements use the original UTC month and duplicate settlement is a no-op. Later price reconciliation is the explicit R3c seam; it must preserve these invariants.

`runMeterConformance(factory)` injects a millisecond clock into the adapter factory and proves atomic holds, overrun settlement, optional person scope, isolation, the concurrency marker, priced-call concurrency, expiry with the hold intact, and late settlement ownership. A persistent adapter must implement these atomically across processes, preserve holds through restarts, bound its transaction calls, and pass the suite. The current in-memory implementation demonstrates conditional semantics only and is not crash-persistent.

## Stream and key-cache behavior (Round 2 fix)

An ended-task record is keyed by issuer, company and task. Admission checks it, then streaming rechecks it before each chunk and every second while idle. A failed check aborts the stream under the same total call deadline. Ended notices, disconnects and deadlines still stop the transport; a post-send abort settles the full hold under the existing fault rule. No notice endpoint is introduced.

Provider HTTP 429 and 529 heads are explicit rejections before output is received. They use the existing not-sent/rejected accounting outcome: **zero input and zero output**, `estimated: false`. The response body is neither consumed nor forwarded; the client gets the fixed provider error. Other non-2xx heads and faults after an accepted response retain the existing full-hold rule.

The secret scanner matches whole credentials and their encodings, plus 24-byte windows of distinctive material. JWT header/payload fields are public structured metadata; partial-token scanning uses its cryptographic signature, excluding shared headers such as `eyJhbGci`. Key windows exclude fixed key-format prefixes such as `sk-ant-api03-`. Common prefixes alone pass. A bounded window lookup avoids a pattern-times-response scan; withholding the longest full credential/encoding tail protects splits across arbitrarily many chunks. The whole response still has the existing 10 MiB bound.

JWKS keys are cached for `JWKS_CACHE_SECONDS = 900` after a successful read. A failed rotation read keeps the last good keys through that original expiry; it neither extends their lifetime nor pauses verification with a still-valid cached key. Fetch failures back off 10 seconds; successful missing-kid fetches remain limited to once per 60 seconds. Removing a kid from the trusted install registry revokes it immediately on the next verification. A successful JWKS refresh replaces the key set; keys removed upstream otherwise remain trusted only until cache expiry. The cache is install scoped because signing keys belong to installs; task/meter/ended data remains company scoped.

## Verification and measurements


Tests use runtime-generated RSA keys and in-process byte streams; no real token or key is stored. The sandbox refuses loopback listeners, so neither the outcome harness nor measurement claims network behavior. Existing Cloud source/tests and web/contracts source remain unchanged. The existing Cloud entry listener test also failed on the unchanged baseline with `EPERM`; a controller/Linux rerun remains required.

Run `node --import tsx scripts/model-gateway-measure.ts` through `heavy.sh`. It performs 300 direct calls followed by 300 gateway calls, with a slow four-frame fake stream. Results below are code overhead only: no TCP hop, TLS, load balancer, provider network, DynamoDB, or production contention. Quantile differences are differences between two sequential sample sets, not paired latency measurements; negative differences reflect scheduling noise. The direct baseline and gateway both must complete all 300 calls.

| Metric (ms) | Direct p50 / p95 / p99 | Gateway p50 / p95 / p99 | Difference p50 / p95 / p99 |
|---|---:|---:|---:|
| Time to first byte | 1.229 / 1.321 / 1.498 | 2.666 / 2.943 / 3.156 | 1.437 / 1.622 / 1.658 |
| Total completion | 4.747 / 4.938 / 5.119 | 5.164 / 5.522 / 5.783 | 0.417 / 0.584 / 0.664 |

The pre-fix measurement run added 1.622 ms at p95 first byte and 0.584 ms at p95 completion. These historical measurements predate Round 2; they do not measure the new scanner or ended-task checks. These sequential measurements were made while other queued local checks ran; they are scheduling-sensitive observations, not a production latency guarantee. For a real path, assume (unverified) 2–10 ms per database transaction and 1–10 ms for the extra hop. Reserve plus hop therefore gives approximately **5–22 ms added p95 first-byte latency**; reserve plus settle plus hop gives approximately **6–31 ms added p95 completion latency**. Those ranges add assumptions to the measured differences; they are not measured distributed percentiles. TLS setup, retries and database contention could add more. The provider transport itself makes no retry.

## Idle infrastructure arithmetic (not verified prices)

Every unit price below is **assumed, verify** from memory, in USD, using 730 hours/month. No AWS, network lookup or deployment was performed. These are illustrative inputs, not a quote or measured bill. Two small tasks and an ALB are assumed in one US region; database usage remains low. Provider/model usage, substantial transfer, WAF, support, taxes and extra interface endpoints are excluded.

| Line | Unit price (assumed, verify) | Arithmetic | Monthly USD |
|---|---|---|---:|
| Two Fargate tasks, each 0.25 vCPU, 0.5 GiB | $0.04048/vCPU-hour; $0.004445/GiB-hour | 2 × 730 × (0.25 × 0.04048 + 0.5 × 0.004445) | 18.02 |
| One ALB, plus 0.1–1 LCU | $0.0225/hour; $0.008/LCU-hour | 730 × (0.0225 + [0.1,1] × 0.008) | 17.01–22.27 |
| Two ALB public IPv4 addresses | $0.005/address-hour | 2 × 730 × 0.005 | 7.30 |
| Small DynamoDB store (1 GiB; 1–5M write units; 0.25–1M read units) | $0.25/GiB-month; $0.625/M writes; $0.125/M reads | 0.25 + [1,5] × 0.625 + [0.25,1] × 0.125 | 0.91–3.50 |
| Two KMS keys and 10,000 requests | $1/key-month; $0.03/10,000 requests | 2 × 1 + 0.03 | 2.03 |
| Logs (1–10 GiB ingested and retained) | $0.50/GiB ingestion; $0.03/GiB-month storage | [1,10] × (0.50 + 0.03) | 0.53–5.30 |
| Five–ten standard alarms | $0.10/alarm-month | [5,10] × 0.10 | 0.50–1.00 |
| Public task egress alternative: two task IPv4 addresses | $0.005/address-hour | 2 × 730 × 0.005 | 7.30 |
| Private task egress alternative: one–two NAT gateways plus addresses and 1–10 GiB processing | $0.045/gateway-hour; $0.005/address-hour; $0.045/GiB | [1,2] × 730 × (0.045 + 0.005) + [1,10] × 0.045 | 36.55–73.45 |

Use exactly one egress alternative. Rounded totals: **$54–$67/month with public task egress**, or **$83–$133/month with one–two NAT gateways**. These are lower than the plan's $90–$160 at the low end because of quarter-vCPU tasks, tiny database/log volume and minimal ALB capacity. Larger tasks, endpoints, traffic or additional observability can close or exceed the difference. Public task egress is an arithmetic scenario, not an approved network design. 9d replaces assumptions with the staging Cost Explorer reading and verified regional prices.

## Not built

Infra/deployment/TLS/IAM, DynamoDB adapter, company provider-key store, live model-limit table, production price/correction wiring, product-AI/F1-d route, OpenAI routes, Bedrock, Vertex, signed task-ended notices/sender, budget settings, application integration and a hold reaper. No dependencies or lockfile changes, no AWS, and no changes to Cloud's existing server or Code engine. The R3c lane report records its early DNS test-harness incident and subsequent fixes.

## R3c: live prices and correction (review required before use)

The binding Round 5 model replaces the earlier per-source precedence, peer-median, raise-only and floor-transition rules. `price-sanity.ts` owns pricing: it pools observations, calculates candidates, publishes effective prices and resolves requests. Fetchers retain observations and fixed classification reasons. `SnapshotPriceSource` indexes the published result; no model request fetches prices.

A model identity is (provider family, normalized model ID). IDs fold case and surrounding whitespace; Bedrock also folds its existing regional/provider prefixes and date/version suffixes, and Gemini folds its `gemini/` prefix. All aliases and all source rows for one identity pool together. Malformed provider metadata can join an unambiguous identity previously established for that **exact** source ID, including after restart; it is uncertain. A never-seen or ambiguous ID does not establish a provider. A never-seen unknown-provider lookup uses the flat $100/M fallback; ambiguous metadata cannot reassign an established identity. Providers sharing a string stay separate.

Each clean row contributes each known billing tier ×1.0: input, output, cached-read, 5-minute cache-write, 1-hour cache-write and the corresponding long-context tiers. Every uncertain row with positive finite base rates contributes its known tiers ×1.5, including unknown modes, unrecognized cost/price fields, deprecation, malformed metadata, over-max rates and per-request markers. Each tier participates in its own component maximum; a costly write or long-context tier never inflates ordinary input or cached-read settlement. The candidate token price is the **component-wise maximum of these contributions**. Ordinary clean models use their real price. For example, a clean $15/$75 alias plus an uncertain $0.5/$2.5 alias remains $15/$75; an uncertain $15/$75 alias contributes $22.5/$112.5. A cheaper AWS row never overwrites a dearer LiteLLM row.

Per-request policy takes the component-wise max of the flat $100/M treatment and the identity's token candidate. The flat treatment cannot hide known token rates; exact per-request billing is still unimplemented. With no token contribution, a model uses the provider/kind's dearest candidate ×1.5, or flat $100/M without a known provider price. A per-request row without token rates uses flat $100/M. Provider maxima include clean and uncertain **token contributions held through drop confirmation**, excluding artificial flat amounts; consequently an unknown sibling of a sole uncertain $15/$75 identity uses $33.75/$168.75. A contributing identity uses its own candidate, rather than inheriting a dearer sibling's price. Unknown kinds contribute to both chat and embedding maxima. Overrides ship empty, expire within 90 days and fill source gaps only.

The snapshot persists one published **effective price** and at most one pending lower candidate per identity. Every rising component is accepted immediately. Any falling component retains the component-wise max of old and new and marks the result estimated until the same complete lower candidate is observed on two consecutive successful refreshes. Equality includes every billing tier, long-context threshold and overflow-review state. A previously absent long-context band is compared at its previously active base rate, so introducing a cheaper explicit band also needs confirmation. This applies equally to small clean decreases, source/alias disappearance while another contribution remains, classification and per-request flag changes. A failed contributing source clears confirmation evidence, preserves its rows and fetchedAt, and cannot lower a price. An unrelated source's failure does not prevent confirmation. If all observations of an identity disappear after successful fetches, the no-contribution provider/flat fallback is a candidate under that same confirmation rule. Prices do not age out or inflate merely because they are old. `estimated` is false only when a clean row supports the effective price and no uncertainty or fallback raised it; an unconfirmed drop remains uncertain. Correction may use this conservative effective price, and only the uncertainty of used tiers determines whether the call remains eligible.

All conversions round up. Above the ordinary $1,000/M schema maximum, positive readable rates remain uncertain observations, including AWS rates. Safe integer arithmetic saturates before conversion or ×1.5 overflow, flags `operatorReview`, and holds/settles `Number.MAX_SAFE_INTEGER`; caps still apply. The gateway emits a fixed `price_operator_review` event. Individually safe rates whose usage total overflows also saturate. No price error refuses a call by itself (DEC 216).

LiteLLM and AWS use injected bounded transports with fixed HTTPS URLs, no redirects, total source byte/node/item/depth limits and deadlines. AWS regional files share one budget. Raw entries, uncertain floors, unpriced/per-request rows and unidentified rows share a 20,000-row bound per source. The pooled published snapshot has at most 40,000 identities and **40,000 aliases in total**, including retained history. Current aliases are protected; the oldest retained history is evicted in snapshot insertion order (oldest identities, then oldest aliases within an identity). Fully evicted identities are removed before candidate construction, so even a full 40,000-identity replacement remains bounded and subsequent refreshes can continue. Each identity has at most one pending price and two source references. Maps and maxima are built once in linear bounded passes under the existing 60-second refresh deadline, with no model-times-peer scan. Legacy snapshots remain readable and are not rewritten by reload. Refresh saves by version CAS and triggers the correction hook; the daily timer retries hourly after failure and can stop. Health reports age, counts and fixed failure labels. Persistence and production scheduling remain unwired.

Settlement with positive usage charges usage × effective price, at least one micro. OpenRouter reported cost uses max(valid reported cost, token usage cost) when token rates are known (or overflow review is required). A larger reported cost is known; a binding uncertain token floor remains estimated and retains usage for correction. Without known token rates, a valid positive reported cost can replace the cautious estimate. Missing/zero/invalid usage and post-send faults retain the full hold. The reported-cost floor and later corrections use exactly the same tier-wise cost function. Unknown tiers never borrow another identity's rate, uncertainty, overflow state, or source dependencies. `UNKNOWN_READ_FACTOR = 1` uses own input; `UNKNOWN_WRITE_FACTOR = 2` uses own input for either duration (R3a M3's highest provider multiplier); `UNKNOWN_LONG_FACTOR = 2` uses own base input/output separately. Published long thresholds are retained; a contributing identity without a published band uses `UNKNOWN_LONG_THRESHOLD = 200_000`, matching the existing AWS long-context band. Missing cache components within a long band derive from that band's input. Multipliers apply after the identity's uncertainty scaling and saturate safely with operator review. Completed prices carry bounded derived/uncertain component masks. Only nonzero usage of these components makes a call estimated. Legacy injected R3a sources and wholly unknown flat/provider fallback prices preserve their token rates; snapshot resolutions additionally carry the version. Plain-input holds use the request-size bound described above. Known tiers remain exact, including zero cached-read rates. Legacy `cacheWriteMicrosPerMTok` overrides still supply both write durations. Cache tier counts must be whole, nonnegative, complete and sum to the total before entering the ledger. The no-send/429/529 exceptions and all DEC 180 reservation/marker rules are unchanged: one overrun-capable call per company, concurrent bounded priced calls, and marker expiry never releases a hold.

Correction uses the ledger's original month and target items, adds its delta to current spend/committed values, replaces the call's prior amount in `estimatedMicros` with its newly priced amount while any used tier remains derived/uncertain, or removes it when all used tiers are known, recomputes overrun against supplied caps, and records from/to/delta/source/fetchedAt/run/time. It never refuses a correction for exceeding a cap. The snapshot correction port supplies the current effective price and monotonic snapshot version. Completed correction rates validate up to the safe-integer bound; raw rows retain their original schema bound. The same resolved object supplies both settlement rates and `priceVersion`, even if a refresh arrives during streaming. The settle-ledger records that version. Legacy rows without a version are version 0. A correction must supply a strictly newer version than settlement or the last correction; absent, equal and older versions cannot change money or remove a pending row. Each partial correction atomically updates `settledMicros`, retains pending/expiry indexes, and records `priceVersion`; repeat or older versions are no-ops. Zero-usage tiers never block finality. Final corrections remove pending/expiry indexes. Status and version conditions make concurrent repeats idempotent. Past 62 days, `correct` marks a pending record expired and retains its estimated charge. Independently, `runExpirySweep` uses an expiry index and `expire` transaction to close records whose models never receive prices. It changes only status/time/run audit fields, preserves estimated spend, and never invents price provenance. It races safely with correction on the pending status condition. Logs carry fixed events and validated numbers only. A durable meter must use one transaction over the ledger and every touched item, ADD-based deltas, a `status = pending` condition plus a monotonic price-version condition, and bounded transaction completion; it must pass `runMeterConformance` and conflict/race proofs. The in-memory hook permits controlled fault injection for those tests.

`pendingKeys`, `pendingFor` and `pendingExpired` return bounded pages with opaque index-scoped keyset cursors. The runner yields after one call page per key, including the last key, and keeps at most 20,000 per-key resume cursors (oldest cursor eviction safely rescans). Thus a growing fallback-only queue cannot monopolize corrections for other models. The runner owns continuation in a WeakMap keyed by the meter instance; use the same instance on each scheduled/post-refresh invocation. Restarting safely rescans from the beginning. Concurrent runs can revisit pages but cannot double-apply a pending-status transaction. Correction counts keys plus calls against one 200-item budget; expiry has a separate 200-record maintenance budget. Each run has one 25-second deadline covering reads and writes. These are independent jobs: schedule both, including expiry when no prices are gained. Production scheduling remains unwired.

The `correct`/`expire` port contract requires completion or failure within the supplied AbortSignal lifetime, capped at 25 seconds. An unconfirmed transaction returns `status: "unknown"`; the runner reports an `unknown` count and fixed `price_correction_unknown` event, continues past the call and retries it idempotently with bounded per-call backoff (Round 3 below). It never claims that an unknown write failed to commit. The in-memory adapter bounds its async pre-write hook and checks cancellation again before its synchronous transaction; `runMeterDeadlineConformance` proves abort, no late write, and retry for both operations. Persistent adapters must satisfy this contract, not merely race a non-cancellable write.

Unknown correction outcomes no longer stop the page. Each correction transaction has a one-second AbortSignal deadline inside the existing 25-second/200-item run limit, then the runner continues to later calls. A pending call backs off 60 seconds, then 120 seconds, and receives at most three unknown attempts before `price_correction_operator_review`. The ledger remains pending for operator review and the independent 62-day expiry sweep; no unknown write is labelled failed or rolled back. Retry state, like continuation, belongs to the meter instance and is in memory; restarting resets retry scheduling, while the pending-status transaction still prevents duplicate charges. At most 20,000 retry records are retained; saturation emits the same operator-review event and leaves further calls pending. Production wiring must persist or otherwise own this retry state. Concurrent runners share attempt reservations. Adapters must honour cancellation and prevent late writes.

Upward corrections can take a company **more than one call over its cap**. This is the accepted DEC 172 residual: several estimated calls can finish before their real higher prices arrive. The single in-flight marker does not bound the sum of their later corrections. Every upward correction leaving committed spend (including outstanding holds) beyond any supplied cap records `capExceeded` atomically in its audit row, even if its acknowledgement is lost. Successful acknowledgements also emit the fixed `price_correction_cap_exceeded` event. Later upward corrections while already over cap are counted too; idempotent repeats do not add an audit event. Corrections remain uncapped.

The Q1–Q5 rulings remain in force where not replaced by the binding Round 5 pricing addendum. A newly listed model dearer than the provider's cautious maximum can still be undercharged before a source identifies it; pooled maxima can overcharge. Provider maxima for never-seen models retain the held token rates until a drop receives the same two-fetch confirmation, including across reloads. No OpenRouter fetcher or routed end-to-end OpenRouter call exists here: OpenRouter prices come through LiteLLM, and its final `usage.cost` shape remains an assumed fixture pending staging verification. The opt-in live-check prints counts/age/fixed skipped reasons and writes no snapshot. Infra/IAM, persistent adapters, live fixture checks, OpenRouter/product-AI routes, live tier verification, Azure, budget settings and UI remain outside this lane. Do not enable this draft for customers before the security-list gate and independent money review.

Round 5 tests drive the real fixture fetch → refresh → persisted snapshot → resolve → estimate/settle path, including the actual Anthropic gateway. The seeded property covers multiple sources, aliases, independent rate components, classifications, failures and repeated candidates, asserting current maxima, two-fetch decreases and exact confirmed clean prices. Round 6 adds real cached-heavy/write-heavy/long-context settlement, correction, unknown-tier fallbacks, runtime tier validation and a seeded tier extension of the property. Every gateway test installs `denyNetwork()`; fixtures are hand-made and no live-price validation is claimed. Mutation evidence and the complete gateway gate are recorded in the lane's Round 5 report.


## Round 6: tier boundaries and charge-direction risks

Every long-context band LiteLLM uses (`above_32k_tokens`, `100k`, `128k`, `200k`, `256k`, `272k`, `512k`; `CONTEXT_THRESHOLDS`) is retained separately; a row naming any other band stays unknown. AWS's offer never states where its `long_ctx` band starts: fetchAWS stores it above 200,000 prompt tokens (`AWS_LONG_CONTEXT_FALLBACK`), and pooling moves it down to the lowest band the identity's LiteLLM rows state (Claude Haiku 5.5: 100k), never later. A LiteLLM row past its deprecation date whose every field is known (floor reason `deprecated price`) prices its identity at its exact rates only when no non-deprecated row (either source) names that identity; otherwise it is only an alias. Each refresh that uses one logs `price_deprecated_used` once, with the number of identities. Prompt tokens include ordinary input, cached reads and cache writes; the higher band applies strictly above its threshold, to all components of that call. Unsupported price dimensions remain uncertain under the existing classification policy. There is still no live source verification or new provider route. Old snapshots remain readable; old already-collapsed prices cannot recover discounted tiers until a successful refresh supplies them and any drop is confirmed.

Under-charge protections are per-tier maxima across aliases/sources, immediate increases, two-fetch confirmation for decreases, positive reported-cost floors, validated counts/rates, unknown-tier fallbacks, overflow review and highest-tier reservations. The corresponding **over-charge risks** are uncertain observations at ×1.5; unknown-tier fallbacks above the actual provider price; decreases held until confirmed; and component-wise maxima across pooled rows (a composite tier schedule may exceed any single row). A reservation uses the highest possible tier, so it can temporarily hold more budget than the final usage costs; post-send faults retain that full hold. A clean known cached-read call settles at its cached-read rate, not the uncached input rate.


Round 7 adds real-path sibling isolation and own-tier fallback/correction tests, partial downward and upward corrections, used-tier finality, unused uncertain/write-duration controls, version replay and stale-version races, expiry, malformed provenance, and sibling-invariance extensions to the seeded property. Repricing always starts from the call's **current** settled amount; a concurrent new settle survives the delta. The same partial correction version is a no-op even when the call remains pending. The persistent adapter must implement these extended conditions before deployment; it is still not implemented here.


## Round 8: reviewed exclusions and PR money risks

`UNSERVED_FEATURE_COST_FIELDS` in `price-classify.ts` is the explicit per-feature exclusion list for plain token calls. The listed token fields also cover their recognized `above_128k_tokens` / `above_200k_tokens` variants; there is no general cost/price-field exemption.

| Field | Feature key | Reason it does not apply |
|---|---|---|
| `search_context_cost_per_query` | `web_search` | Web search: provider server tools are rejected by the request guard. |
| `input_cost_per_token_priority` | `priority_service` | Priority service: no service-tier selector is exposed. |
| `output_cost_per_token_priority` | `priority_service` | Priority service: no service-tier selector is exposed. |
| `input_cost_per_audio_token` | `audio_tokens` | Audio token billing: no audio-token provider route is exposed. |
| `output_cost_per_audio_token` | `audio_tokens` | Audio token billing: no audio-token provider route is exposed. |
| `input_cost_per_image_token` | `image_tokens` | Image token billing: no separate image-token provider route is exposed. |
| `output_cost_per_image_token` | `image_tokens` | Image token billing: no separate image-token provider route is exposed. |

Anthropic inline media is still unbounded input, billed through its ordinary input-token usage and guarded by the company marker; these exclusions do not invent a separate media pricing route. **Before exposing any listed feature, remove its exclusion and implement its billing.** A row with only listed extra cost fields stays clean at ×1.0 and permits parallel bounded calls. Any other unrecognized cost/price field still makes the row uncertain at ×1.5.

PR risk list, both charge directions:
- **M1:** corrections skip operator-review prices (including completed prices), saturated used rates and saturated totals; each skipped call remains estimated, counted and pending with `price_correction_operator_review`. No correction can move any meter row to the saturated value. A reviewed, non-saturated replacement must pass normal drop confirmation before correction. This prevents the $9-billion overcharge; the retained estimate can remain above or below real cost until review/confirmation, or expire still estimated.
- **M2:** settle and correction versions are monotonic per call. An older replica cannot lower a newer settlement or finalize it at a stale price. A stale replica may delay reconciliation in either direction until it reloads.
- **M3:** the exact list above prevents permanent ×1.5 charges and busy serialization from prices of unavailable features. Unknown fields still cause cautious overcharges. Exposing a listed feature without removing its exclusion would undercharge its fee, so list removal and billing are a feature prerequisite.
- **Priority/audio/image:** premium rates no longer raise standard token charges, and cheaper feature rates never lower standard charges. Their separate tariffs are not served here; enabling them without billing would undercharge. Existing snapshots that folded them into standard rates can retain an overcharge until two refreshes confirm the drop.
- Short plain requests reserve only feasible bands and plain input; cache/media calls remain overrun-capable. A provider violating the bounded plain-input contract is outside that ceiling. Post-send faults still retain the full hold.
- Retained alias history is bounded and may eventually be evicted. A later malformed row for an evicted alias cannot recover its former identity and uses existing unknown-price behavior, which can over- or under-estimate. Current rows remain represented. No refresh freezes permanently merely because history crossed 40,000.

The accepted DEC 172 residual still includes clean priced calls whose consumed tiers were derived: later non-saturated upward corrections can cumulatively exceed caps. Persistent versioned adapters, production scheduling, live source validation, Linux/CI proof and the security-list/independent-review gate remain external to this lane.


## Round 9: exclusions follow the request guard

`guard.ts` owns the feature policy: each known feature declares its exposure, tool types and optional request fields. The guard derives its tool and field allowlists from that policy, and exports the same enabled keys as `GATEWAY_EXPOSED_FEATURES`. Currently only `custom_tools` is exposed. `web_search`, `priority_service`, `audio_tokens` and `image_tokens` are known but unexposed. The media keys describe separate token-billing routes; inline Anthropic media retains its existing unbounded-input treatment.

Each `UNSERVED_FEATURE_COST_FIELDS` entry stores `{ feature, reason }`. Tests require a known feature key and reject any exclusion whose feature is exposed, with: `<field> is listed as unserved but <feature> is now exposed; remove the entry so the row is priced or marked uncertain`. Enabling web search in the policy changes actual guard acceptance and fails this test. A misspelled feature key also fails. New tools, modalities or service tiers must use this guard policy; remove their exclusions and price their tariffs or leave their rows uncertain before enabling them. Current request acceptance, fixed refusal text and price classification are unchanged.

## Company-key mode for the agent route (DEC 236)

The core engine's agents call AI through `POST /v1/messages` with their task token, and the gateway holds each company's own
key. With `GATEWAY_AGENT_KEYS=company` (only with the product route, whose sealed store holds the company-level Anthropic
source that learning also reads; the deployed template sets it whenever `rovaraModelGatewayProductAi=on`):

- Admission asks whether the token's company has a key connected (`LearningKeySource.connected`), before any hold. None:
  403 `no_ai_key` "Connect an AI key: ..." (`AGENT_KEY_MISSING`), nothing held or sent. An unreadable store: 503.
- The key is read just before sending. Gone meanwhile: not sent, $0, the same refusal.
- The provider refusing the company's key (401/403): free, 403 `no_ai_key` (`AGENT_KEY_REFUSED`). Other failures keep the
  install-key route's accounting.
- Caps, meter and the combined company cap are unchanged.
- Rovara's install key (`GATEWAY_ANTHROPIC_KEY_SECRET`) is never read: the process gives the handler a refusing key port, and
  a company-key process without its company key source refuses to start.

Absent (or `install`): the install-key route exactly as before.

## Rovara's AI for agents (DEC 240)

In company-key mode each company's admin picks "AI for your agents" in Cloud (`/app/admin/agent-ai`, route
`/org/agent-ai`: company admins, fresh step-up, audited as `agent_ai.source.changed`). Cloud saves it in its Companies table
(`COMPANY#<org>` / `AGENT_AI`); the gateway reads it on every agent call (`agent-ai.ts`, strongly consistent, fail closed):

- `rovara`: Rovara's AI. The call goes to Bedrock in Rovara's OWN account with the gateway task role (no customer role, no
  external id): `InvokeModel` / `InvokeModelWithResponseStream` with the Anthropic body (`bedrock-transport.ts`, SigV4 service
  `bedrock`, fixed host `bedrock-runtime.<region>.amazonaws.com`). The streamed AWS event stream is turned back into Anthropic SSE
  (`bedrock-event-stream.ts`). Only the allow-listed models (`GATEWAY_ROVARA_AI_MODELS`, `<agent model>=<bedrock id>`), in the
  gateway Region's geography (no `global.` profile). The company's own key is never read.
- `anthropic_key`, or no saved choice: company-key mode exactly as above.
- `bedrock_byo` (DEC 238): refused for now (403 `no_ai_key`, "your own Bedrock is not available yet").

There is no fallback between sources: Rovara's AI chosen on a gateway without it is refused (403), and so is a company key that is
missing. Money (DEC 240b): priced from the `bedrock` price rows (the dearest of their Regions and tiers), under the one combined
company cap, settled from Bedrock's own token counts. Each Rovara's AI call's hold carries a billable line
(`{ source: "rovara_ai", charge, model }`) that lands on its ledger row (`CALL#<id>`) when it settles or is swept: that row's
`settledMicros` is the amount on the company's bill. `charge` is `exempt` only for companies the operator lists in
`GATEWAY_ROVARA_AI_EXEMPT` (the founders' test company), never inferred; caps still apply to them. A Bedrock error answer carries
no output and no token counts, so it is never charged (including 5xx, model timeouts, and an exception that arrives as the stream's
first frame, which the transport answers as its error status); its refusal of Rovara's own role (401, 403) answers 503 "Rovara's AI
is unavailable right now". A stream that breaks after output started is charged at its hold, as on every route.

### The default for exempt companies (DEC 254zzz3(1), L4-AIDEF)

This REPLACES, for the operator's exempt (pilot) companies only, the older "customer always pays / never Rovara-paid model use" rule. A company
named in `GATEWAY_ROVARA_AI_EXEMPT` (the same list as above; the operator adds the pilot company's id) with NO saved choice uses Rovara's AI
automatically, with no click, in this order (`agent-ai.ts` `resolveAgentSource`, one function for the agent route, the answers and learning routes and the
offered-models list): a saved choice always wins; else its own connected Anthropic key; else its own connected Bedrock; else Rovara's AI. Switching back
to Rovara's AI later is an explicit saved choice. A company that is not exempt, or a gateway without Rovara's AI, is exactly as before (company-key mode). A read
that fails refuses the call (503) and never guesses onto Rovara's account; there is no fallback from one source to another.
The same default serves the answers and learning routes (`learning-route.ts` `rovaraDefault`): only where the call would otherwise pause `no_provider`
(no connected Anthropic account, Anthropic Messages path only), the company is exempt and its effective source is Rovara's AI; an explicit other source (or its own
Bedrock, which those routes never served) keeps today's pause. Every cap applies unchanged to the spend: task, person, project, company, the combined company cap,
the upkeep month (agent route), the answers month and the learning month. The call's ledger row carries `{source: "rovara_ai", charge: "exempt", model}` (nothing is
billed to the company); each agent call also logs `{event: "agent_source", company, source, via}` (ids and words only). Cloud's AI settings screen shows the
effective source when `CLOUD_ROVARA_AI_EXEMPT` (the same ids) is set on Cloud's server: pass the SAME `-c rovaraModelGatewayRovaraAiExempt=<org ids>` to the Cloud deploy (`-c rovaraCloudApp=<env>`) as to the gateway's. It changes words only; no IAM, secret or parameter, and refused for production at synth.

Models (DEC 243): `-c rovaraModelGatewayRovaraAi=on` offers every Claude model Bedrock has in the account, each engine model name on
its `us.` system inference profile (US cross-Region routing; data stays in the US): `claude-haiku-4-5` (and the dated
`claude-haiku-4-5-20251001`), `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2`
(`ROVARA_AI_US_MODELS`). Only `us.` profile ids are accepted (no plain model id, no `global.`). Each is priced by the AWS price
list's Bedrock row and limited by its Anthropic row. Sonnet 5.5, Opus 5.5 and Fable 5.2 need the account's one-time Marketplace
enable; until then a call answers 503 `model_not_enabled` ("This model is not enabled yet on Rovara's AI ...") and is not charged.

Deploy: `-c rovaraModelGatewayRovaraAi=<allow-list or on>` (and optionally `-c rovaraModelGatewayRovaraAiExempt=<org ids>`) beside
`-c rovaraModelGatewayProductAi=on`; refused for production at synth. The serving role then gets exactly `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream` on the allow-listed inference profiles in its Region and, only through those profiles
(`bedrock:InferenceProfileArn`), their foundation models in the profile's Regions (a `us.` profile serves from us-east-1, us-east-2
and us-west-2). The role has no Marketplace rights: an operator enables each model once in the account (Bedrock console or one
invoke by an admin) before Rovara's AI is switched on.

### Other Bedrock models through Converse (DEC 243c)

An allow-list entry for a non-Claude Bedrock model (`<id>=<id>`: the model id in this Region, or its `us.` profile id)
is called through Converse / ConverseStream (`bedrock-converse.ts`; Converse is authorised by the same two IAM actions as
InvokeModel). The engine names such a model exactly by the Bedrock id that is called, as Code's model catalog does. The gateway translates the checked Anthropic request
(system, text, `tool_use` / `tool_result`, tools, `tool_choice` auto/any/tool, temperature) and the answer back, including
ConverseStream to Anthropic SSE (usage arrives on the final `message_delta`); reasoning blocks are dropped, and images,
documents, thinking blocks and `tool_choice: none` are refused before any hold (400). A call is held to the model's own output
limit from the price snapshot's Bedrock row (4,096 when unknown), and priced from its Bedrock rows (dearest-of). The grant is the
model in this Region, or its profile plus (only through it) the profile's Regions. A model is
listed only after an agent-loop test on fakes and one tiny real call pass. `-c rovaraModelGatewayRovaraAi=on` also offers these ten
(`ROVARA_AI_US_CONVERSE_MODELS`; each answered a real one-tool ConverseStream call with a tool call, 2026-11-15, replayed in
tests from `tests/fixtures/model-gateway-bedrock/converse`): `qwen.qwen3-coder-480b-a35b-v1:0`, `qwen.qwen3-coder-30b-a3b-v1:0`,
`qwen.qwen3-235b-a22b-2507-v1:0`, `mistral.devstral-2-123b`, `mistral.mistral-large-3-675b-instruct`, `deepseek.v3-v1:0`,
`moonshotai.kimi-k2.5`, `zai.glm-5`, `zai.glm-4.7`, `us.amazon.nova-2-lite-v1:0`. Tool call ids pass through as the model gives
them (Kimi K2.5's look like `functions.ping:0`). Three reasoning-first models are listed too, after a real call with maxTokens
256 (`tests/fixtures/model-gateway-bedrock/converse-256`): `openai.gpt-oss-120b-1:0` and `openai.gpt-oss-20b-1:0` (their
`reasoningContent` is dropped: OpenAI only recommends passing it back after tool calls) and `us.amazon.nova-pro-v1:0`, whose
answer starts with its reasoning as plain text: for that model only, exactly a leading, well-formed `<thinking>...</thinking>`
(the first text block starting with `<thinking>`, up to the first `</thinking>`, within 64 KiB) is left out; anything else passes
unchanged. Not listed: DeepSeek V3.2 (its provider requires reasoning to be sent back in tool loops, it writes raw tool-call
markup into its text, and in the owner's real two-turn call of 2026-11-16 its turn 1 ended end_turn with no tool call and no
thinking). Listed after that call passed (a tool call with a thinking block on turn 1, a normal end on turn 2; answers in
`tests/fixtures/model-gateway-bedrock/two-turn-real`): Kimi K2 Thinking, MiniMax M2.5, Kimi K3 and Kimi K3.1. For those four and DeepSeek V3.2 (`REASONING_CARRYOVER_MODEL` in `bedrock-converse.ts`) the gateway carries reasoning both ways: Converse `reasoningContent` (text, and a signature when there is one; no real stream has shown one) becomes an Anthropic
`thinking` block (streamed as `thinking_delta` / `signature_delta`; an unsigned block has an empty signature), and a `thinking`
block in the history goes back as `reasoningContent` with its text exactly, before the tool result's turn. Blank unsigned reasoning
and whitespace-only assistant text (MiniMax writes `"\n\n\n"` between its reasoning and the tool call) are left out of what goes
back; redacted content and anything malformed fail the call, never part of a block. Every other model still drops its reasoning and
refuses a `thinking` block. The real two-turn call is `scripts/bedrock-reasoning-two-turn.ts`, run through `staging-aws.sh` (see that file's header).
`ROVARA_AI_MODELS_MAX` is 24 (and `rovaraAiModelIds` in infra/lib/model-gateway.ts): `on` offers 23. GLM 5.3 and Grok 4.7 are not available to the account.
