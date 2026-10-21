# rovara-audit-verify

Checks a Rovara audit ledger export offline. It needs Node 22 and nothing else: the package has no
dependencies and talks to no network.

```
rovara-audit-verify <bundle[.gz]> [--extends <older[.gz]>] [--trust <label>=<pem file> ...] [--json] [--print-openssl]
```

Exit codes: 0 every check passed, 1 a check failed, 2 usage or parse error.

## What it checks

| Check | What it proves |
| --- | --- |
| `chain` | Every record hashes to its own `hash` and links to the one before it, from the record the export starts after. Edited, removed, added or reordered records break it. |
| `sealRanges` | The seals belong to this organization, follow each other without gaps and do not reach past the records in the export. |
| `batchRoot` | The records in each seal's range give the Merkle root (RFC 9162) the seal recorded. |
| `headHash` | The last record in each seal's range is the head the seal recorded. |
| `prevSealHash` | Each seal links to the one before it (the first to `previousSeal`, or to the organization's genesis). |
| `epochs` | Each epoch id has one statement, and epoch ids and `closedAt` never go backwards across the seals. A timestamp belongs to a statement's hash, never to an epoch id alone. |
| `inclusion` | Each seal is a leaf of its epoch's seals root, by an RFC 9162 inclusion proof for a tree of the epoch's `sealCount` seals. |
| `timestamps` | Each RFC 3161 token signs the hash of its epoch statement, chains to the pinned roots for its own authority label, and carries a time no more than 5 minutes before the last record the seal covers. |
| `coverage` | An epoch with no token of its own is covered when a later epoch's statements chain to it, one by one through `prevStatementHash`, up to an epoch with a valid token. |
| `details` | Any erasable details included in the export match the commitments in their records. |

An epoch that has no token and no cover is listed, not failed.

Bundle-supplied certificates are never trusted. Tokens are checked only against the roots pinned
in this package (DigiCert and Sectigo, each for its own label) and any roots you add with
`--trust <label>=<pem file>`, for example your own time-stamping authority.

The text under "What this ledger proves" below is printed from this program, never taken from the
bundle you give it.

## Keep every export, and run `--extends`

A single export cannot show that history was rewritten and sealed again before you took it. Keep
each export you take, and check a newer one against an older one:

```
rovara-audit-verify newer.json.gz --extends older.json.gz
```

`--extends` checks both exports on their own, then that they are for the same organization, that the
newer one is sealed at least as far as the older one, and that the record and the seal at the older
export's last sealed record are identical in both. If records were rewritten and re-sealed, it fails
and names that record's `seq`.

## Checking a timestamp with OpenSSL alone

`--print-openssl` prints, for every token in the export, the commands to decode it and check it
without this program. In outline, for an epoch statement whose SHA-256 is `<digest>`:

```
printf '%s' '<token base64>' | openssl base64 -d -A > token.tst
openssl ts -verify -digest <digest> -in token.tst -token_in -CAfile <authority root>.pem
```

`<digest>` is the SHA-256 of the epoch statement as canonical JSON (RFC 8785, keys sorted, no
whitespace); the program prints the statement and an `openssl dgst -sha256` line to reproduce it.

## What this ledger proves, and what it does not

> What this ledger proves: the records in this export have not been changed, removed or reordered since Rovara sealed them, and each sealed batch existed no later than the time an independent timestamp service signed.
>
> What it does not prove: that the records are true or complete. Rovara writes them, so an action Rovara never recorded, or recorded wrongly, does not show up as tampering. Records after the last seal are not sealed yet; this export says how many.
>
> It is tamper-evident, not tamper-proof. Someone with enough access could still change Rovara's live copy, but the change would show when checked against the sealed copy, the timestamps and your earlier exports. Keep every export you take.
