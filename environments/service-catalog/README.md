# Service image catalog: repack, then pin

`catalog.json` is pinned in two operator steps. Neither runs in tests or CI. Both need the owner's OK and, on staging, go through `~/.local/share/rovara-tools/staging-aws.sh` (account 944937319445, us-west-2).

1. **Repack** (`scripts/catalog-repack.ts`): each upstream image (postgres, redis ...) becomes a Rovara-built OCI index with exactly the catalog's platforms, by digest. Writes the sources file.
2. **Pin** (`scripts/catalog-build.ts`): mirrors, takes an SBOM and a scan per platform, signs and writes the pinned catalog. It reads the sources file from step 1.

## What repack does

For every non-retired entry it reads the upstream index by the digest the operator reviewed, checks the bytes hash to that digest, selects `linux/amd64` and `linux/arm64` (the entry's platforms; either missing refuses the run), copies those two child manifests and their blobs by digest into `rovara-catalog/<env>/svc/<name>`, builds a new OCI index of only those two (annotations `io.rovara.repack.source.reference`, `io.rovara.repack.source.digest`, `io.rovara.repack.time`), pushes it by digest, tags it with the first 32 hex digits of its digest (so the repository's lifecycle policy never expires it), reads it back and checks it, then writes the provenance record and the sources file.

- Child digests are upstream's, unchanged: nothing is rebuilt.
- **Attestation manifests are dropped.** BuildKit attestations (`unknown/unknown`) in the upstream index describe how upstream built its image, not this index, so the new index has none. The provenance record lists every manifest left out and why. Rovara's own SBOM and scan come from `catalog-build`.
- A tag is refused. Any refusal stops the run before the sources file is written; the read phase refuses before anything is copied.
- The repack time is part of the index, so a new run is a new index digest. **Retry an aborted run with the same `--repack-time`** (the run prints its time at the start): the indexes already pushed and tagged for completed entries are then reused, not left orphaned beside new ones, and the immutable tags are not touched again (a tag that already points at the right digest is skipped; one that points at another digest stops the run). Without `--repack-time` a retry makes new indexes.
- Before any registry work the run checks the outputs: both directories exist (or are created) and are writable, the two files differ, and an existing sources or provenance file is refused unless `--overwrite` is passed.
- Every skopeo inspect and oras command is killed after 10 minutes by default (`--command-timeout-seconds`), and each `skopeo copy` after 45 minutes (`--copy-timeout-seconds`). `catalog-build` takes the same two flags: its `skopeo copy` and `syft` runs get the 45-minute limit, `skopeo inspect` the 10-minute one.

## Operator run on staging

Needs `skopeo` and `oras` **1.2.0 or newer** (for `oras resolve`) on PATH, and the owner's OK for these exact commands. **Upstream images must be anonymously pullable**: no upstream credential is used, so a private upstream is refused by the registry. Docker Hub limits anonymous pulls per IP, so a run over many images can stop on a rate limit; wait and retry with the same `--repack-time`.

**Smoke test first.** The script has only ever run against fakes, and four command forms have not met a real registry: `skopeo inspect --raw docker://<ref>@sha256:<d>`, `skopeo copy --preserve-digests` from a digest to a digest, `oras manifest push <repo>@sha256:<d> <file>`, and `oras tag` / `oras resolve` (including a repeat tag of the same digest in an immutable-tag repository). With the owner's OK, create a throwaway ECR repository in staging through `staging-aws.sh` (for example `rovara-repack-smoke`), run those four against one small multi-platform upstream image and that repository, check each result with `skopeo inspect --raw` and `oras resolve`, then delete the repository. Only then run the real repack. Write the repack file first (review each upstream index digest yourself, for example with `skopeo inspect --raw docker://docker.io/library/postgres:16 | shasum -a 256` then confirm what it lists):

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

## The emulator (`local-aws@r1`): a Rovara-built source

The emulator is not repacked from an upstream image. The fork's manual GitHub workflow (`image.yml`, `sign=false`, `platforms=linux/arm64`) builds an UNSIGNED OCI layout and writes its index digest; nothing on GitHub is trusted. Download the run's `image-result` artifact, unpack it in its own new folder, and name it in a sources file as a Rovara-built source:

```json
{ "schemaVersion": 1, "sources": { "local-aws@r1": { "kind": "rovara-built", "layout": "artifact/oci", "digestFile": "artifact/index.digest" } } }
```

Relative paths are read from the sources file's folder. `catalog-build` then (1) checks the layout on disk (one image, an index whose bytes hash to the digest file's digest, each platform manifest present and hashing to its digest, platforms exactly the entry's: `linux/arm64`), (2) pushes it by that digest into `rovara-catalog/<env>/svc/local-aws`, (3) requires the registry to serve the same digest and the same platform manifests, and (4) takes its own SBOM and ECR scan of the arm64 manifest (any critical finding refuses) and signs with the release KMS key. A Rovara-built source is refused for any entry that is not `emulated`. Run it with `--entries local-aws@r1` (the exact commands are in the lane report).
