# R3a: Cloud model gateway core

This package is an unwired Cloud service core. It implements Anthropic Messages through injected ports and a `node:http` adapter. It is not a deployed service, a Code engine module, or a production money store. TC-1 is pinned by the shared JSON and its SHA-256 test; task signing kids are pinned separately from developer signing kids, and only `rovara_purpose: "task"` JWKs are imported (ADDENDUM-4). Missing, developer or unknown purposes receive the same fixed 401 as an unknown key. The shared constants include `TASK_KEY_PURPOSE` and the JWK member name; 9d must reconcile this new JSON hash with R3b before merge. Sign-in purpose enforcement must deploy before publishing the second key. `src` is optional and reporting-only.

## Money and concurrency (ADDENDUM-3)

`ModelLimitsSource` supplies each model row's own maximum output independently of `PriceSource`. Tests inject rows; no live model or price table is included. A missing or malformed limit, or a request above that limit, receives fixed `400 invalid_request` words before any hold or provider call. An omitted `max_tokens` uses the full row maximum. Every provider request carries the applied maximum; the reservation record and settlement event record it.

For known prices and inline text/function input, the hold uses **every byte of the serialized provider request**, plus a 4,096-token allowance when tools are present, plus applied maximum output, multiplied by the applicable rates and rounded up once with integer arithmetic. The old two-million-input ceiling and 64,000-output fallback are gone. The provider's enforced maximum output and the inline byte bound make this a ceiling; settlement is never clipped or refused. Cache reads use the full input rate (conservative). Anthropic cache writes use 1.25× input for reported five-minute writes and 2× for reported one-hour writes; any unclassified cache-write tokens use 2×. An optional validated `cacheWriteMicrosPerMTok` on the price row overrides those defaults. Fractional micro-dollar arithmetic is rounded up once, after summing all categories. Malformed tier details fail the complete response and retain the fault charge; absent tier details are explicitly classified at 2×.

Unknown prices use the cautious rate, hold a positive estimate and settle at the full hold. Input that cannot be bounded at the plain input rate (media, remote source/cache fields including cached tool definitions, unknown content kinds) is also overrun-capable, even with a known price. Unknown prices never cause a price refusal. Native fileData/cachedContent routes are not implemented here; when added, their fixed reservations must take this same marker.

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

Infra/deployment/TLS/IAM, DynamoDB adapter, company provider-key store, live price/model table, R3c charge correction, product-AI/F1-d route, OpenAI routes, Bedrock, Vertex, signed task-ended notices/sender, budget settings, application integration and a hold reaper. No dependencies or lockfile changes, no network/AWS, and no changes to Cloud's existing server or Code engine.
