# Install Rovara AI emergency stop (DEC 328)

The Companies table reserves `pk=INSTALL#ROVARA_AI`, `sk=SETTING` for exactly one
item: `{pk, sk, enabled, version, updatedAt, updatedBy}`. Absent means enabled.
Do not put any other sort key or audit row in that partition. The gateway makes
only a strongly consistent GetItem on this key, with a cache of at most 60 seconds
(including read latency). An expired cache never permits a call on a read error.

Every call whose resolved source is Rovara AI is checked in the shared gateway
admission path, before reservation, reviewer-session debit or provider send. This covers agents, setup, upkeep, reviewers, e2e_agent, answers,
learning and Slack company chat. Billing exemption does not bypass it. Customer
keys and customer Bedrock are unaffected. In-flight provider calls may finish;
the running task's next call receives HTTP 403 with the existing `not_allowed`
error type and exactly:

> Rovara's AI is paused on this install. Your work is safe; try again later or use your own AI source.

Code owns presenting this refusal and pausing the task without retrying. There is
one switch: Code does not create or cache a second authority.

## Operator toggle

Build `npx tsc -b packages/cloud-server`. With explicit local operator credentials,
run (substitute the deployed table names and region):

```sh
node scripts/model-gateway-rovara-ai-stop.mjs --region us-west-2 \
  --companies-table COMPANIES_TABLE --audit-table CLOUD_STATE_TABLE --state paused
```

Use `--state enabled` to resume. The interactive command shows the destination and
STS operator ARN and requires the displayed phrase. It has no customer HTTP route,
UI, server-index export, or serving-role write grant. Use the operator's existing
permissions; this change grants the gateway only GetItem on the reserved partition.

The writer rejects every other key before storage. It strongly reads the current
version, then atomically writes the setting, the existing append-only audit row
and its id marker. Concurrent edits fail their version condition; errors never
fall back to an unaudited write. Audit records use scope `INSTALL#ROVARA_AI` in the
Cloud State audit store (`AUDIT#INSTALL#ROVARA_AI#<month>` and its `AUDITID#` marker),
actor type/id `operator`, actor name the STS ARN, and the server's timestamp. They
are outside the setting partition and cannot be read through company audit APIs.
The ordinary company-id validator continues to reject this scope.

The gateway's new IAM statement is `dynamodb:GetItem` only on the Companies table,
with `ForAllValues:StringEquals` LeadingKeys `INSTALL#ROVARA_AI` and the required
non-null context guard. LeadingKeys restricts the partition, not the sort key;
the approved sole-item invariant and fixed reader/writer enforce `sk=SETTING`.
9d must simulate the deployed role plus permissions boundary before install and
prove pause/resume on staging after installation.
