"""Builds the synthetic team-record corpus and the query set for the retrieval eval (lane L0). Deterministic (fixed seed). All content is invented.

Rows: the 32 hand-written topics (4 rows each: PR summary, decision record, task note, thread comment), 12 long documents (weekly notes whose one
useful fact sits early or late in the text), and filler rows (small changes, notes and review comments that reuse the topics' vocabulary but answer none of the queries).
Queries: relevant rows for a topic query are the four rows of that topic; for a long-document query, that one document.
"""
from __future__ import annotations

import random
from typing import Any

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from topics import TOPICS  # noqa: E402

SEED = 20261112

FILES = ["src/queue/consumer.ts", "src/cache/session.ts", "src/db/migrate.ts", "src/auth/token.ts", "src/api/routes.ts", "src/jobs/export.ts", "src/indexer/bulk.ts",
         "infra/modules/storage/main.tf", "infra/modules/network/main.tf", ".github/workflows/ci.yml", "docs/runbooks/oncall.md", "tests/integration/flow.test.ts",
         "src/billing/ledger.ts", "src/notify/email.ts", "src/flags/client.ts", "src/metrics/emit.ts", "config/defaults.json", "scripts/backfill.sh"]
TEST_PLANS = ["Ran the unit tests and the integration suite locally; both green.", "Deployed to staging and watched the dashboards for an hour.",
              "Added regression tests that fail on the old behaviour.", "Verified manually against a copy of production data.", "CI is green; no manual steps needed.",
              "Load tested for ten minutes with no errors; rollback plan is a revert of this commit."]

LIBS = ["linter", "http client", "date library", "test runner", "logger", "schema validator", "retry helper", "metrics client", "queue client", "cache client"]
SERVICES = ["invoice export", "receipts sync", "thumbnail generator", "search indexer", "billing ledger", "notification sender", "session service", "reporting api",
            "admin console", "partner api", "import service", "audit trail"]
THINGS = ["queue consumer", "cache layer", "token validation", "migration script", "webhook handler", "feature flag client", "pagination helper", "bulk indexer",
          "rate limiter", "log formatter", "retry wrapper", "upload handler", "email template", "time zone helper", "currency formatter", "alert rule"]
PEOPLE = ["Ana", "Ben", "Chen", "Dara", "Eli", "Fay", "Gus", "Hana"]

FILLER_TEMPLATES = [
    "Bump the {lib} from {a} to {b}. No behaviour change; changelog reviewed and the {thing} tests still pass.",
    "Rename the config key {k1} to {k2} in the {svc}. Old key still read for one release and logs a deprecation warning.",
    "Task note: update the onboarding page for the {svc}. Added a section on running the {thing} locally and where its logs go.",
    "Review comment from {p}: nit, prefer a named constant over the literal in the {thing}. Not blocking, happy to merge after the rename.",
    "Add unit tests for the {thing} in the {svc}. Covers the empty input, the single item and the maximum size cases.",
    "Refactor the {thing} to remove a duplicated helper. Pure move, no logic change, diff is mostly deletions.",
    "Decision: the {svc} keeps its current {thing}; we looked at replacing it and the migration cost was not worth the benefit this quarter.",
    "Task note: pair session with {p} on the {thing}. Documented how it is wired so the next person does not need to ask.",
    "Fix a typo in the error message of the {thing}. The message said 'recieved'. Added the missing test for the message text.",
    "Comment from {p}: the {svc} dashboard has a panel nobody looks at anymore, proposing to delete the {thing} panel and keep the summary.",
    "Add a short comment explaining why the {thing} in the {svc} is not async. It looked like an oversight but it is intentional for ordering.",
    "Chore: delete dead code from the {svc}. The {thing} branch behind the old flag has been unreachable since the last release.",
    "Task note: quarterly cleanup of the {svc} backlog. Closed 14 stale issues that mention the {thing}, kept 3 that still reproduce.",
    "Thread: should the {svc} log the {thing} at info or debug? Settled on info for state changes, debug for each item.",
]

PARAGRAPH_TEMPLATES = [
    "The {svc} team reported steady progress this week. Work on the {thing} continued, with {n} of {m} planned tasks closed and the rest scheduled for next sprint.",
    "Reliability review: no customer-facing incidents this week. One minor alert from the {svc} was acknowledged and closed as a false positive after checking the {thing}.",
    "Hiring update: interviews for the platform role continue, {n} candidates in the final round. Onboarding material for the {svc} was refreshed for the new joiner.",
    "Cost review: spend on the {svc} was flat week over week. The {thing} cleanup should save a small amount next month; we will confirm in the next sync.",
    "Docs: the runbook for the {svc} was reviewed by {p} and {p2}. Two stale commands in the section about the {thing} were corrected.",
    "Dependencies: {n} minor upgrades were merged for the {svc}. Nothing needs a migration. The {thing} is now on the latest patch release.",
    "Planning: the next release train leaves in two weeks. The {svc} has {n} items committed and the {thing} is the main risk we are watching.",
    "Support trends: ticket volume was normal. The most common question was about the {thing} in the {svc}; a help article draft is with {p}.",
    "Security housekeeping: access reviews for the {svc} are due at the end of the month. {p} will collect the owners' confirmations.",
    "Performance: median latency of the {svc} is unchanged. The {thing} shows a small improvement after last week's tuning, within noise.",
]

# (kind, head subject, the fact paragraph, query)
LONG_FACTS = [
    ("late", "Compliance retention", "Decision recorded in this sync: audit log retention moves from 1 year to 7 years for customers on the regulated plan. Older logs go to cold storage after 90 days and stay queryable through the export tool.", "how long are audit logs kept for regulated customers"),
    ("late", "Secret rotation", "Agreed in this sync: webhook signing secrets rotate every 90 days, and the old secret keeps working for a 24 hour overlap so receivers can switch without dropping events.", "overlap window when changing the signing secret for outgoing callbacks"),
    ("late", "Mobile support", "Heads up from the mobile team: the March release drops support for iOS 15 and Android 8. Together they are under 2 percent of active devices; those users see an update prompt.", "which old phone operating system versions are we ending support for"),
    ("late", "Media delivery", "The image pipeline will serve thumbnails as WebP at quality 80 instead of JPEG. Early numbers show about 30 percent less bandwidth with no visible quality loss in the side by side review.", "switching picture format to cut bandwidth"),
    ("late", "Backups", "The nightly restore test for the reporting replica failed twice. Root cause: the trigram extension was missing on the replicas. Installing pg_trgm on all replicas fixed it and the restore test is green again.", "why did the backup restore verification fail on the read replica"),
    ("late", "Status communication", "The public status page moves to an independent provider hosted outside our cloud region, so it stays reachable when our own infrastructure is down. DNS cutover is planned for next Tuesday.", "where will the customer status page be hosted so it survives our outage"),
    ("late", "On-call", "On-call handoff moves from Monday 09:00 to Thursday 15:00 local time. Weekend handovers lost context and caused two slow responses last quarter. The calendar has been updated.", "when does the rotation change over between engineers on call"),
    ("late", "Database protection", "To protect the primary database we cap concurrent report exports at 3 per workspace. Extra requests wait in a queue and the user sees their position. The limit is configurable by support for large accounts.", "limit on simultaneous data exports for each customer workspace"),
    ("early", "Data residency", "First item: customer data for the EU region will be stored only in the Frankfurt region starting next quarter. Backups stay in the same region and the replication to the US cluster is turned off for those accounts.", "where is european customer data stored"),
    ("early", "Billing", "First item: invoices are generated on the first business day of the month instead of the last calendar day. Finance asked for this so that usage from the final day is complete before the run.", "when do monthly invoices get generated now"),
    ("early", "Search quality", "First item: we are adding typo tolerance of one edit for words longer than five characters in workspace search. Short words stay exact to avoid noisy matches.", "fuzzy matching rules for misspelled search terms"),
    ("early", "Accessibility", "First item: the web app now meets the AA contrast ratio in both themes. The chart palette was adjusted and focus outlines are visible on every interactive element.", "colour contrast standard the web app now satisfies"),
]


def _boiler(rng: random.Random) -> str:
    files = ", ".join(rng.sample(FILES, 3))
    return f"\nFiles changed: {files}.\nTest plan: {rng.choice(TEST_PLANS)}"


def _filler_row(rng: random.Random) -> str:
    template = rng.choice(FILLER_TEMPLATES)
    return template.format(lib=rng.choice(LIBS), a=f"{rng.randint(1, 9)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}", b=f"{rng.randint(1, 9)}.{rng.randint(0, 9)}.{rng.randint(0, 9)}",
                           thing=rng.choice(THINGS), svc=rng.choice(SERVICES), k1=rng.choice(["maxItems", "retryLimit", "pollSeconds", "batchSize"]), k2=rng.choice(["itemLimit", "retryBudget", "pollInterval", "chunkSize"]),
                           p=rng.choice(PEOPLE))


def _paragraph(rng: random.Random) -> str:
    return rng.choice(PARAGRAPH_TEMPLATES).format(svc=rng.choice(SERVICES), thing=rng.choice(THINGS), n=rng.randint(2, 9), m=rng.randint(10, 14), p=rng.choice(PEOPLE), p2=rng.choice(PEOPLE))


def build(filler_rows: int = 350) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rng = random.Random(SEED)
    rows: list[dict[str, Any]] = []
    queries: list[dict[str, Any]] = []
    kinds = ["pr", "decision", "task", "thread"]
    pr_no = 1200
    for index, (topic, texts, qs) in enumerate(TOPICS):
        ids = []
        for kind, text in zip(kinds, texts):
            if kind == "pr":
                pr_no += rng.randint(3, 40)
                text = f"PR #{pr_no}: {text}{_boiler(rng)}"
            row_id = f"{topic}:{kind}"
            ids.append(row_id)
            rows.append({"id": row_id, "kind": kind, "topic": topic, "text": text})
        # first query of every topic, the second (identifier style) for every third topic
        for q_index, (query, qkind) in enumerate(qs):
            if q_index == 1 and index % 3 != 0:
                continue
            queries.append({"id": f"{topic}:q{q_index}", "query": query, "kind": qkind, "relevant": ids, "long": None})
    for index, (position, subject, fact, query) in enumerate(LONG_FACTS):
        paragraphs = [f"Weekly platform sync notes, week {index + 20}. Focus area: {subject}."]
        lead = 3 if position == "early" else 12
        for _ in range(lead):
            paragraphs.append(_paragraph(rng))
        paragraphs.insert(1 if position == "early" else len(paragraphs), fact)
        for _ in range(3):
            paragraphs.append(_paragraph(rng))
        row_id = f"long-{position}-{index}"
        rows.append({"id": row_id, "kind": "long", "topic": row_id, "text": "\n\n".join(paragraphs)})
        queries.append({"id": f"{row_id}:q0", "query": query, "kind": f"long-{position}", "relevant": [row_id], "long": position})
    for index in range(filler_rows):
        rows.append({"id": f"filler-{index}", "kind": "filler", "topic": "filler", "text": _filler_row(rng)})
    rng.shuffle(rows)
    return rows, queries


if __name__ == "__main__":
    rows, queries = build()
    print(len(rows), "rows,", len(queries), "queries")
    from collections import Counter
    print(Counter(q["kind"] for q in queries))
    print(Counter(r["kind"] for r in rows))
