"""Hand-written topics for the team-record retrieval eval (lane L0). Every topic is a small engineering story told in four rows of
different kinds (PR summary, decision record, task note, thread comment). Topics come in sibling pairs (same area, different
problem) so a search has to tell near neighbours apart. All names and systems are invented; nothing here is real data.

TOPICS[i] = (topic_id, [pr, decision, task, thread], [(query, kind), ...])
kinds: para = paraphrase, little shared wording; ident = an identifier, number or config name; why = a decision/cause question.
"""

TOPICS = [
    ("queue-visibility", [
        "Raise the invoice-export queue visibility timeout from 30 s to 180 s. The consumer function runs up to 30 s and was being redelivered mid-flight, so the same invoice batch was exported twice. New value is six times the function timeout.",
        "Decision: queue visibility timeout is always six times the consumer timeout, set in one shared constant. Reason: duplicate exports in March traced to a 30 s visibility window against a 28 s p99 run.",
        "Task note: confirm no other consumer queue is below 6x its function timeout. Found two (receipts-sync, thumbnail-gen); filed follow-ups. Duplicate exports stopped after deploy.",
        "Comment from Lee: the double-sent exports were not a bug in the exporter, the message just became visible again before the first worker acked it. Longer window fixes it, idempotency would be belt and braces.",
    ], [("why were invoice exports sent twice to customers", "para"), ("visibility timeout six times consumer timeout", "ident")]),
    ("queue-dlq", [
        "Stop the poison-message loop on the invoice-export queue. Set maxReceiveCount to 5 and add a redrive-safe dead-letter queue plus an alarm when its depth is above zero for 10 minutes. A single malformed currency code had been retried 1.9 million times.",
        "Decision: every queue gets a DLQ with maxReceiveCount 5 and a depth alarm. We do not auto-redrive; a person reads the message first.",
        "Task note: wrote the runbook page for replaying DLQ messages by hand after the cause is fixed. Added a script that dumps a message without deleting it.",
        "Comment from Sam: the retry storm ran all weekend and cost us real money in lambda invocations; nobody was paged because there was no alarm on the failure path at all.",
    ], [("what stopped a malformed message from being retried forever", "para"), ("maxReceiveCount 5 dead-letter alarm", "ident")]),
    ("cache-session", [
        "Change Redis maxmemory-policy from allkeys-lru to volatile-ttl for the session cluster. Under memory pressure LRU evicted live session keys and users were logged out in the middle of checkout. Sessions all carry a TTL so volatile-ttl only drops the oldest-expiring ones.",
        "Decision: session data lives in its own Redis cluster with volatile-ttl, never shared with the product cache. A shared cluster means a cache burst can sign people out.",
        "Task note: split the session keyspace to the new cluster; dual-read for two days, then cut over. Logout complaints dropped to zero in the support queue.",
        "Comment from Priya: customers kept saying the app 'forgets who I am' around the lunchtime traffic peak. That matched the memory graph, eviction count spiking exactly then.",
    ], [("why were users being signed out during busy periods", "why"), ("volatile-ttl redis session cluster", "ident")]),
    ("cache-stampede", [
        "Add request coalescing in front of the pricing endpoint. When the cached price list expired, hundreds of requests all rebuilt it at once and the database spiked. Now the first request rebuilds and the others wait for its result (singleflight), with a 5 s stale-while-revalidate window.",
        "Decision: hot read endpoints must use singleflight plus stale-while-revalidate. A fixed TTL alone is not allowed on anything above 50 requests per second.",
        "Task note: load test with 500 concurrent clients, database connections stayed under 40. Documented the helper in the platform wiki.",
        "Comment from Dev: the outage every morning at 09:00 was the price list TTL lining up with the start of the working day. Thundering herd, classic.",
    ], [("many requests rebuilding the same expired cached value at once", "para"), ("singleflight stale-while-revalidate pricing", "ident")]),
    ("migration-lock", [
        "Rewrite the orders migration so it adds the new column as nullable, backfills in batches of 10k rows, and only then sets NOT NULL. The previous single-statement migration held an exclusive lock on orders for 40 seconds and checkout timed out.",
        "Decision: no migration may take an exclusive lock on a table over 1M rows. Use add nullable, backfill, then constrain. CI lints for ALTER TABLE ... NOT NULL without a default.",
        "Task note: backfill finished in 22 minutes on production with no visible latency change. Removed the temporary batch script.",
        "Comment from Mara: the table was locked while the migration ran and every checkout request queued behind it; it looked exactly like an outage for forty seconds.",
    ], [("how do we add a required column to a big table without blocking writes", "para"), ("exclusive lock orders table migration backfill", "ident")]),
    ("migration-order", [
        "Prefix migration files with a UTC timestamp instead of a sequence number, and add a CI check that fails when two branches add the same number. Two merged branches both created migration 0147 and staging applied them in the wrong order.",
        "Decision: timestamp-named migrations only; renaming existing files is out of scope. The CI check compares the migration directory against main.",
        "Task note: implemented the check as a 30-line script, wired into the lint job. Added a test fixture with a deliberate collision.",
        "Comment from Lee: this bit us twice already. Whoever merges second silently gets a different order than what they tested locally.",
    ], [("two branches created the same database migration number", "para"), ("timestamp prefix migration filenames ci check", "ident")]),
    ("auth-clock-skew", [
        "Allow 60 seconds of clock leeway when validating JWT issued-at and not-before claims. Some phones with drifting clocks got 401 right after login because the token looked like it was issued in the future.",
        "Decision: token validation accepts up to 60 s of clock skew in either direction. We will not go higher; longer leeway widens the replay window.",
        "Task note: reproduced with a device clock set 45 s ahead. Added unit tests with fake clocks for skew of 59 s and 61 s.",
        "Comment from Sam: support saw a pattern, mostly older Android devices, failing exactly once after sign-in and working on retry. Smelled like time.",
    ], [("login worked then immediately returned unauthorized on some phones", "para"), ("jwt leeway 60 seconds nbf iat", "ident")]),
    ("auth-refresh-reuse", [
        "Add a 10 second grace window to refresh-token reuse detection. On a flaky network the client retried a refresh whose response was lost, the second use looked like theft and we revoked every session for that user.",
        "Decision: reuse of a rotated refresh token within 10 s from the same device is treated as a retry, not an attack. Outside the window or from a new device, revoke the family.",
        "Task note: added metrics for graceful retries vs real reuse. Two weeks in, 312 graceful retries and 3 real revocations.",
        "Comment from Priya: users on trains were being logged out of everything. The security rule was right in principle but it punished bad connectivity.",
    ], [("why were users kicked out of all devices after a network blip", "why"), ("refresh token rotation reuse grace window", "ident")]),
    ("ci-flaky-checkout", [
        "Stabilize the checkout end-to-end test: wait for network idle and for the button animation to finish before clicking pay. The test failed about one run in eight because it clicked while the button was still sliding in.",
        "Decision: e2e tests may not use fixed sleeps. They must wait on an observable condition. A lint rule bans waitForTimeout.",
        "Task note: ran the checkout spec 200 times in a loop, 200 passes. Quarantine label removed from the test.",
        "Comment from Dev: it was never the payment code, the test was racing the UI. We lost days chasing a backend ghost.",
    ], [("end to end test that fails intermittently because it clicks too early", "para"), ("waitForTimeout lint rule banned fixed sleeps", "ident")]),
    ("ci-cache-key", [
        "Fix the dependency cache key in CI to use a hash of the lockfile instead of its modification time. The mtime changed on every checkout so the cache never hit and installs took 6 minutes.",
        "Decision: cache keys are content hashes only. Anything derived from time, branch name or runner is not allowed in a cache key.",
        "Task note: median pipeline time went from 14 minutes to 8. Added a dashboard panel for cache hit rate.",
        "Comment from Mara: builds were slow for weeks and everyone blamed the runners. The cache simply never matched.",
    ], [("why was every pipeline run reinstalling all packages", "why"), ("ci cache key lockfile hash mtime", "ident")]),
    ("obs-log-volume", [
        "Sample the hot-path debug logs at 1 percent. A leftover debug statement in the request handler doubled our log ingestion bill in one month. Errors and warnings are still logged in full.",
        "Decision: debug level logs in request handlers are sampled, never unconditional. Log cost has a monthly budget alert at 120 percent of forecast.",
        "Task note: confirmed ingestion fell by 55 percent. Set a retention of 14 days for debug streams and 90 for audit.",
        "Comment from Lee: finance pinged us about the logging line item. It was one forgotten console.debug inside a loop.",
    ], [("our monitoring bill suddenly doubled, what was the cause", "why"), ("sample debug logs 1 percent request handler", "ident")]),
    ("obs-latency-alert", [
        "Replace the static p99 latency threshold alert with a multi-window burn-rate alert on the checkout SLO. The old alert fired on every short blip and the on-call had started ignoring it.",
        "Decision: paging alerts are SLO burn-rate alerts only; threshold alerts become tickets. Fast burn 14.4x over 1 h and 5 min, slow burn 6x over 6 h.",
        "Task note: replayed the last quarter of metrics; the new rule would have paged 4 times instead of 61. Two of the four were real incidents.",
        "Comment from Sam: alert fatigue was real. People muted the channel, and then we missed the one that mattered.",
    ], [("on-call keeps getting woken by noisy latency pages, what did we change", "para"), ("burn rate alert slo checkout 14.4x", "ident")]),
    ("upload-multipart", [
        "Add a bucket lifecycle rule that aborts incomplete multipart uploads after 7 days. Abandoned uploads left invisible parts that still counted toward storage, about 3 TB by the time we noticed.",
        "Decision: every bucket that accepts multipart uploads must have an abort-incomplete-multipart rule at 7 days or less.",
        "Task note: the cleanup freed 3.1 TB and the monthly storage line dropped by about 70 dollars a day. Added a terraform module default for the rule.",
        "Comment from Dev: the console showed the bucket as much smaller than the bill suggested. Incomplete parts do not appear in the object list.",
    ], [("storage cost much higher than the files we could see", "para"), ("abort incomplete multipart upload lifecycle 7 days", "ident")]),
    ("upload-presign", [
        "Extend presigned upload URLs from 15 to 60 minutes and have the client request a fresh URL if the upload is still running at the 45 minute mark. Large video uploads on slow connections failed with an expired signature.",
        "Decision: presigned URL lifetime is 60 minutes for uploads, 5 minutes for downloads. Uploads over 2 GB must use resumable multipart.",
        "Task note: tested with a throttled 1 Mbps connection and a 1.5 GB file; completed in 38 minutes with one URL refresh.",
        "Comment from Priya: customers in remote offices could never finish uploading big recordings, they just saw access denied at the end.",
    ], [("large file upload fails with signature expired on slow internet", "para"), ("presigned url 60 minutes refresh at 45", "ident")]),
    ("search-bulk", [
        "Reduce the Elasticsearch bulk indexing batch from 50 MB to 5 MB. The full reindex kept stalling with circuit breaker errors on the coordinating nodes; smaller batches finished in 2 hours.",
        "Decision: bulk requests are capped at 5 MB or 2,000 documents, whichever comes first. The cap lives in the indexer config, not in call sites.",
        "Task note: reindex of 90M documents completed with zero rejected bulks. Heap on coordinating nodes peaked at 61 percent.",
        "Comment from Mara: we kept raising the heap when the real fix was sending less per request.",
    ], [("full reindex of the search cluster kept hanging", "para"), ("bulk request cap 5 MB circuit breaker", "ident")]),
    ("search-sku", [
        "Add a custom analyzer so hyphenated product codes such as AB-1234-X are indexed both as the whole code and as parts. Searching for the code with or without hyphens now returns the same product.",
        "Decision: product code search uses a word-delimiter analyzer with preserve-original. Exact-code matches get a boost of 10 over partial matches.",
        "Task note: added 40 regression queries from real support tickets; all return the right product in the top 3.",
        "Comment from Lee: warehouse staff type codes from memory, sometimes with dashes and sometimes without. Search treated them as different words.",
    ], [("searching a part number without the dashes finds nothing", "para"), ("word delimiter analyzer preserve original sku", "ident")]),
    ("pay-webhook", [
        "Make the payment webhook handler idempotent by storing the processor event id with a unique constraint before writing ledger entries. The processor retried a slow webhook and we posted the same payment twice.",
        "Decision: every webhook handler dedupes on the provider event id inside the same transaction as the side effect.",
        "Task note: backfilled 17 duplicate ledger entries and reversed them with a signed finance approval. Added a reconciliation report that checks for duplicates daily.",
        "Comment from Sam: finance noticed the books were off by a few hundred dollars. The payment processor says retry is normal if you do not answer in 10 seconds.",
    ], [("customer was charged and recorded twice after a retried callback", "para"), ("webhook idempotency event id unique constraint ledger", "ident")]),
    ("pay-currency", [
        "Store all money amounts in minor units as integers and use a currency table for the exponent. Yen has zero decimals, and our float conversion produced amounts 100 times too high on JPY invoices.",
        "Decision: no floating point for money anywhere. Amounts are integers in minor units plus an ISO currency code; rounding is banker's rounding at display only.",
        "Task note: audited all invoices in zero-decimal currencies, found 9 wrong ones, corrected and notified customers.",
        "Comment from Priya: a Japanese customer was billed a hundred times the right number. We got lucky that their bank flagged it.",
    ], [("invoice in yen came out a hundred times too large", "para"), ("minor units integer currency exponent no float money", "ident")]),
    ("deploy-rollback", [
        "Adopt the expand-contract pattern for schema changes so every release can be rolled back. Last week a blue/green rollback failed because the new release had dropped a column the old code still read.",
        "Decision: destructive schema changes ship one release after the code stops using them. Rollback must always be possible for N-1.",
        "Task note: added a deploy gate that checks the migration for DROP and RENAME statements and requires an explicit second-release label.",
        "Comment from Dev: we tried to roll back during the incident and it made things worse; the old version crashed on the missing column.",
    ], [("rollback of a release failed because a database column was dropped", "para"), ("expand contract schema change n-1 rollback", "ident")]),
    ("deploy-canary", [
        "Fix the canary analysis that was stuck at 5 percent traffic in the new region. The health metric was published under a different namespace there, so the analysis saw no data and neither promoted nor rolled back.",
        "Decision: canary analysis must fail closed with an explicit no-data timeout of 10 minutes that triggers rollback and a page.",
        "Task note: unified the metric namespace across regions through the shared module. Verified a canary promotes in all three regions.",
        "Comment from Mara: the rollout looked healthy because nothing was failing, but it was also not progressing. It sat there for six hours.",
    ], [("gradual rollout never advanced beyond the first few percent in one region", "para"), ("canary no data timeout fail closed namespace", "ident")]),
    ("flags-bootstrap", [
        "Bootstrap feature flags from a bundled JSON snapshot at start-up and refresh in the background. Cold-start functions waited 800 ms for the flag service before serving the first request.",
        "Decision: flag evaluation never blocks a request on the network. A stale snapshot is acceptable for up to 5 minutes.",
        "Task note: p99 cold start dropped from 1.4 s to 0.6 s. Snapshot is generated at build time and verified by a checksum.",
        "Comment from Lee: the first request after idle was always slow and traces showed it was the flag lookup, not our code.",
    ], [("first request after idle was slow because of a remote config lookup", "para"), ("flag snapshot bootstrap background refresh", "ident")]),
    ("flags-cleanup", [
        "Introduce a 90 day expiry policy for feature flags. A weekly job opens a ticket for each flag past its expiry and the owning team must remove the flag or extend it with a reason.",
        "Decision: temporary flags carry an owner and an expiry date at creation. Permanent flags are labelled ops or entitlement and are exempt.",
        "Task note: first run found 212 expired flags; 150 were deleted in the first sprint. Code paths behind dead flags were removed.",
        "Comment from Priya: nobody knew which of the 400 flags were still live. A few were load-bearing in odd ways.",
    ], [("how do we stop old feature toggles piling up", "para"), ("flag expiry 90 days owner ticket", "ident")]),
    ("email-bounce", [
        "Add a suppression list fed by bounce and complaint notifications. Hard-bounced addresses are no longer retried, which brought our sender reputation back above the provider threshold.",
        "Decision: hard bounces and spam complaints are suppressed permanently; soft bounces after 3 attempts over 72 hours.",
        "Task note: imported 8,400 historic bounces. Complaint rate fell from 0.31 percent to 0.04 percent.",
        "Comment from Sam: the email provider warned us about our reputation. We were mailing dead addresses every night.",
    ], [("emails being blocked because we kept mailing dead addresses", "para"), ("suppression list hard bounce complaint", "ident")]),
    ("email-digest-tz", [
        "Send the daily digest at 08:00 in each user's own time zone instead of 08:00 UTC. People in Sydney were getting the morning summary at 6 pm.",
        "Decision: scheduled user-facing notifications are stored with the user's IANA time zone, not a UTC offset, to handle daylight saving.",
        "Task note: backfilled time zone from browser settings for 91 percent of users; the rest default to the workspace zone.",
        "Comment from Mara: an Australian customer asked why our 'morning' digest arrives after work.",
    ], [("summary email arriving at the wrong time of day for people overseas", "para"), ("digest iana time zone per user 08:00", "ident")]),
    ("api-cursor", [
        "Add the record id as a tiebreaker to cursor pagination. When many rows shared the same created_at, clients skipped or repeated items between pages.",
        "Decision: cursors encode the sort key plus the primary key; sorts must be total orders.",
        "Task note: wrote a property test that pages through 10k rows with identical timestamps and checks each id appears exactly once.",
        "Comment from Dev: a partner reported missing orders in their export. The orders existed, the cursor jumped over them.",
    ], [("paginated list API skipped some items between pages", "para"), ("cursor pagination tiebreaker primary key created_at", "ident")]),
    ("api-ratelimit", [
        "Introduce per-API-key token bucket rate limiting at 100 requests per minute with a burst of 20. Over-limit calls get 429 with a Retry-After header. One runaway integration had been taking the whole API down.",
        "Decision: limits are per key, not per IP, and configurable per plan. Internal services use a separate unlimited key.",
        "Task note: staged rollout in log-only mode for a week; 3 keys would have been limited, all known bulk importers who were then contacted.",
        "Comment from Priya: one customer's script hammered us at 50 requests per second and starved everyone else.",
    ], [("one customer script overloaded the public api, how did we limit it", "why"), ("token bucket 100 per minute burst 20 retry-after 429", "ident")]),
    ("etl-watermark", [
        "Add a two hour watermark to the nightly ETL so late-arriving events are included. Mobile events uploaded after offline periods were arriving after the nightly cut-off and never counted in daily active users.",
        "Decision: daily aggregates are recomputed for the previous two days on every run, so late data lands within 48 hours. Dashboards show the freshness.",
        "Task note: DAU for last month was revised up by 3.2 percent after the backfill. Communicated to product.",
        "Comment from Lee: product asked why numbers kept changing; they do now, but only within the two-day window, and we say so on the dashboard.",
    ], [("daily active users undercounted because events arrived late", "para"), ("etl watermark 2 hours recompute previous two days", "ident")]),
    ("etl-compaction", [
        "Add a compaction job that merges small Parquet files into 256 MB files nightly. Streaming writes produced 4 million tiny files and query planning alone took minutes.",
        "Decision: partitions older than a day are compacted to a target size of 256 MB; hot partitions are left alone to avoid write conflicts.",
        "Task note: scan time for the weekly report fell from 11 minutes to 90 seconds. Object request cost dropped by 80 percent.",
        "Comment from Mara: the analytics queries were slow not because of data size but because of the number of files to open.",
    ], [("analytics queries slow because the lake has too many tiny files", "para"), ("parquet compaction 256 MB nightly job", "ident")]),
    ("sec-xml", [
        "Upgrade the XML parser to the patched release and disable external entity resolution. A published vulnerability allowed reading local files through crafted import documents.",
        "Decision: XML parsing is configured with entity resolution off by default through a shared factory; direct parser construction is a lint error.",
        "Task note: scanned the dependency tree, found two other services bundling the old parser; both updated. Added the advisory to the dependency watchlist.",
        "Comment from Sam: the import feature accepted customer-uploaded XML, which makes this exploitable, not theoretical.",
    ], [("vulnerability that let uploaded documents read files from our servers", "para"), ("xxe external entity disabled xml parser factory", "ident")]),
    ("sec-ci-secrets", [
        "Mask secrets in CI logs and rotate the token that was printed by a failing deploy step. The step echoed its environment on error and an API token appeared in a public build log for 20 minutes.",
        "Decision: CI never prints environment variables; secrets come from the secret store at runtime and are masked by name pattern. Any exposure means immediate rotation, no matter how short.",
        "Task note: rotated the token, reviewed access logs for the 20 minute window, found no misuse. Added a log scanner step that fails the job on token patterns.",
        "Comment from Dev: it was a debug line someone added to find a path problem. The log was public because the repo is.",
    ], [("an access token showed up in a public build output", "para"), ("mask secrets ci logs rotate token scanner", "ident")]),
    ("infra-tflock", [
        "Add a force-unlock runbook and a lock timeout to the Terraform pipeline. A crashed run left the state lock held and every apply hung for hours until someone found the stale lock entry.",
        "Decision: pipeline applies use a 10 minute lock timeout and a single serialized queue per state. Force-unlock requires two people to confirm the owner is gone.",
        "Task note: wrote the runbook with the exact lock table query to inspect the holder. Tested on a throwaway state.",
        "Comment from Lee: apply jobs just sat there. The lock record belonged to a runner that no longer existed.",
    ], [("infrastructure deploys hung because a previous run crashed holding the lock", "para"), ("terraform state lock timeout force-unlock runbook", "ident")]),
    ("infra-scaling", [
        "Stop autoscaling thrash on the worker pool by lowering the target CPU from 70 to 50 percent, adding a 10 minute scale-in cooldown and scaling on queue depth per worker instead of CPU alone.",
        "Decision: scale out fast, scale in slow. Scale-in cooldown is at least 5 times the scale-out cooldown. Primary signal is backlog per worker.",
        "Task note: instance count variance dropped; cost down 9 percent because we stopped paying for repeated cold starts of workers.",
        "Comment from Priya: the graph looked like a sawtooth. Instances were created and killed every few minutes.",
    ], [("worker fleet kept growing and shrinking repeatedly", "para"), ("scale-in cooldown backlog per worker autoscaling", "ident")]),
]
