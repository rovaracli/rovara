# Service image catalog: repack, then pin

`catalog.json` is pinned in two operator steps. Neither runs in tests or CI. Both need the owner's OK and, on staging, go through `~/.local/share/rovara-tools/staging-aws.sh` (account 944937319445, us-west-2).

1. **Repack** (`scripts/catalog-repack.ts`): each upstream image (postgres, redis ...) becomes a Rovara-built OCI index with exactly the catalog's platforms, by digest. Writes the sources file.
2. **Pin** (`scripts/catalog-build.ts`): mirrors, takes an SBOM and a scan per platform, signs and writes the pinned catalog. It reads the sources file from step 1.

## What repack does

For every non-retired entry it reads the upstream index by the digest the operator reviewed, checks the bytes hash to that digest, selects `linux/amd64` and `linux/arm64` (the entry's platforms; either missing refuses the run), copies those two child manifests and their blobs by digest into `rovara-catalog/<env>/svc/<name>`, builds a new OCI index of only those two (annotations `io.rovara.repack.source.reference`, `io.rovara.repack.source.digest`, `io.rovara.repack.time`), pushes it by digest, tags it with the first 32 hex digits of its digest (so the repository's lifecycle policy never expires it), reads it back and checks it, then writes the provenance record and the sources file.

- Child digests are upstream's, unchanged: nothing is rebuilt.
- **Attestation manifests are dropped.** BuildKit attestations (`unknown/unknown`) in the upstream index describe how upstream built its image, not this index, so the new index has none. The provenance record lists every manifest left out and why. Rovara's own SBOM and scan come from `catalog-build`.
- A tag is refused. Any refusal stops the run before the sources file is written; the read phase refuses before anything is copied.
- The repack time is part of the index, so a new run is a new index digest. To re-run to the same digest, pass the earlier `--repack-time` (the provenance record's `repackedAt`).

## Operator run on staging

Needs `skopeo` and `oras` on PATH, and the owner's OK for these exact commands. Write the repack file first (review each upstream index digest yourself, for example with `skopeo inspect --raw docker://docker.io/library/postgres:16 | shasum -a 256` then confirm what it lists):

```json
{ "schemaVersion": 1, "entries": { "postgres@16": "docker.io/library/postgres@sha256:<reviewed upstream index digest>", "...": "every non-retired id in catalog.json" } }
```

```sh
REG=944937319445.dkr.ecr.us-west-2.amazonaws.com
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/catalog-repack.ts \
  --repack-file /path/to/repack-staging.json --env staging --registry "$REG" \
  --sources-out /path/to/sources-staging.json --provenance-out /path/to/provenance-staging.json
# then the existing pin step, with the sources file it wrote:
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/catalog-build.ts \
  --sources /path/to/sources-staging.json --env staging --registry "$REG" --kms-key <key id or ARN>
```

Keep the provenance record with the release evidence. The catalog repositories must already exist (created by the release that carries the pipeline).
