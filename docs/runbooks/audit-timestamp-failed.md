# Runbook: the audit anchor cannot get a timestamp

Applies to the alarm `agentx-<env>-AuditTimestampFailed` (one or more `audit.timestamp_failed` log lines in each of two consecutive 15-minute periods) and to the timestamp settings of the audit ledger's anchor.

Nothing is lost while this alarm is on. Sealing goes on: records are sealed, the sealed objects are locked, and each epoch is chained to the one before it. An epoch that has no timestamp yet is `stamp_pending`. The next epoch that gets timestamps from every configured authority covers all the pending ones before it (the chain of statements binds them), and an export built afterwards verifies with the standalone verifier. What is late is the independent proof of time.

## The log line

`audit.timestamp_failed` carries `label` (`digicert`, `sectigo`, `custom-1`, `custom-2`, or `all`), `problem` and `epochId`. It never carries a token or a certificate.

| `problem` | Meaning |
|---|---|
| `timeout`, `network`, `http` | The authority did not answer in time (10 s), could not be reached, or answered with an HTTP status other than 200. On a public install, check that the anchor can reach the authority (see "Network"). |
| `rejection` | The authority refused the request (status other than granted). |
| `malformed` | The answer was not a time-stamp response (an HTML page, a truncated answer, a granted answer without a token). |
| `imprint`, `nonce`, `signature`, `eku` | The answer was a token but not one for this request or not one a verifier would accept: another hash, another nonce, a signer not named by its signing-certificate attribute, a signer certificate without the timestamping usage. Nothing is stored. A repeat usually means the authority or something between it and the anchor is wrong. |
| `untrusted`, `chain` | The token chains to a root that is not pinned for this label (or the chain is not valid at the token's time). On a public install the roots are in the anchor's code; if DigiCert or Sectigo changed the root they sign under, a new root has to be pinned in the verifier and the anchor released. On a custom install, check the roots in the SSM parameter. |
| `roots_unavailable` | A custom install: the roots parameter could not be read at cold start, or is not in the format below. No request is made. The anchor tries again on its next cold start. |
| `stored_token_invalid` | The key `<epochId>.<label>.tsr` already holds an object that does not verify as a token for that epoch. It is not adopted and cannot be replaced (the bucket is locked); the epoch waits and a later epoch covers it. Treat it like an object conflict: see `audit-object-conflict.md`. |
| `version_drift` | The token key holds a delete marker or a second version (also logged as `audit.version_drift`). See `audit-object-conflict.md`. |

Each run asks each authority at most twice (the epoch being closed and the newest epoch that is still waiting), at least 15 seconds apart. An outage does not become a storm of requests.

## Network

The anchor runs outside a VPC, like the broker, so a public install needs nothing of ours to reach the authorities: outbound HTTP (port 80) to `timestamp.digicert.com` and `timestamp.sectigo.com`. If an account-level control (a service control policy, a firewall or a proxy) blocks that, the alarm fires with `timeout` or `network`. A private install whose functions run in a VPC with no outbound access uses a customer-run authority (`agentxAuditTsa=custom`, an internal TSA) or, as a last resort, `off`.

## A customer-run authority (`agentxAuditTsa=custom`)

Context values: `agentxAuditTsa=custom`, `agentxAuditTsaUrls` (one or two `http(s)` URLs, comma-separated) and `agentxAuditTsaRootsParameter` (the name of an SSM parameter). The labels are `custom-1` and `custom-2` in URL order. The anchor may read that one parameter and nothing else in SSM. The parameter's value is the roots, either

- a JSON list with one PEM bundle (a string) per URL, in the URLs' order: `["-----BEGIN CERTIFICATE-----\n...", "-----BEGIN CERTIFICATE-----\n..."]`, or
- for a single URL, the PEM text itself.

A token from one URL is judged only against that URL's roots. An auditor verifying an export gives the same roots to the verifier with `--trust custom-1=<pem file>`.

## `off`

`agentxAuditTsa=off` makes no request. Epochs are sealed without a token and the export says "No independent timestamp". Epochs that were already `stamp_pending` when a stack is switched to `off` stay as they are.
