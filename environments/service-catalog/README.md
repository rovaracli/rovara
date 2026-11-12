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

The emulator is not repacked from an upstream image. The fork's manual GitHub workflow (`image.yml`, `sign=false`, `platforms=linux/arm64`; revision 4 builds from `image/Containerfile.engine`, see the next section) builds an UNSIGNED OCI layout and writes its index digest; nothing on GitHub is trusted. Download the run's `image-result` artifact, unpack it in its own new folder, run `scripts/verify-local-aws-run.sh <RUN_ID> <expected sha> <folder>` (the run must be the `image` workflow, successful, on `main` or `rovara/main` at that sha, and its log must name the digest in `index.digest`; it refuses otherwise), and name it in a sources file as a Rovara-built source:

```json
{ "schemaVersion": 1, "sources": { "local-aws@r1": { "kind": "rovara-built", "layout": "artifact/oci", "digestFile": "artifact/index.digest", "javaScan": "artifact/scan-java-arm64.json", "javaSbom": "artifact/sbom-arm64/java-dependencies.cdx.json" } } }
```

Relative paths are read from the sources file's folder. `catalog-build` then (1) checks the layout on disk (one image, an index whose bytes hash to the digest file's digest, each platform manifest present and hashing to its digest, platforms exactly the entry's: `linux/arm64`), (2) pushes it by that digest into `rovara-catalog/<env>/svc/local-aws`, (3) requires the registry to serve the same digest and the same platform manifests, and (4) takes its own SBOM and ECR scan of the arm64 manifest (any critical finding refuses), requires the artifact's grype scan of the Java libraries inside the native binary (`scan-java-arm64.json`, and `javaSbom`, the CycloneDX list it scanned, which every finding must name a component of; missing, malformed or any critical refuses, before the push; its highs are added to the entry's and its SHA-256 and counts go in the signed statement) and signs with the release KMS key. A Rovara-built source is refused for any entry that is not `emulated`. Run it with `--entries local-aws@r1` (the exact commands are in the lane report).

### Catalog revision 4: the engine is AWS Emulator (owner decisions 105 to 107)

From revision 4 the image behind `local-aws@r1` is a Go front process (Rovara's per-run control token, request ledger, seed, reset) in front of AWS's first-party AWS Emulator, pinned to one version (v1.0.322 at the swap; CC0, with its `vendor/` directory under Apache-2.0; the notices ship in the image as THIRD_PARTY_LICENSES). Saying "built on AWS Emulator" is fine; never imply AWS endorses or sponsors Rovara local AWS. The id, the family, the alias `aws`, port 4566, `/_rovara/*` and the env-file contract are unchanged, so approved plans and seeds keep working: a plan carries the digest read from the live catalog, never one stored at approval, and a worker with an older baked catalog refuses the new digest cleanly. Memory is 512 MiB (decision 106, was 384). The licence is `LicenseRef-Rovara AND CC0-1.0 AND Apache-2.0`. The start timeout stays 30 s: the engine answers in about 0.05 s, so the number is only the upper bound before a start is called failed (a lower one would add no safety and could fail a start on a loaded worker).

The committed `catalog.json` and `prepull.json` carry a PLACEHOLDER pin for `local-aws@r1` (all-zero digest and SBOM hash, a scan stamp in 2000) until the image exists. `tests/contract/local-aws-engine-pin-guard.test.ts` fails while any placeholder is in either file, and `shipped-catalog-trust.test.ts` fails until `catalog.sig.json` signs the real bytes, so neither can ship by accident. To replace it, with the owner's OK and each step previewed:

1. Start the fork's `image` workflow by hand on branch `rovara/front` (platforms `linux/arm64`; the engine Containerfile), download `image-result` into a new folder.
2. `LOCAL_AWS_RUN_BRANCH=rovara/front scripts/verify-local-aws-run.sh <RUN_ID> <full head sha> <folder>` (the extra branch is accepted only while the engine is not merged into `rovara/main`).
3. Sources file entry: `{ "kind": "rovara-built", "layout": "oci", "digestFile": "index.digest", "embeddedLibraryScan": "not_applicable" }` (the engine is Go and Rust; syft and the ECR scan read those binaries), or give `javaScan` and `javaSbom` (the names are historical: any CycloneDX list of embedded libraries and grype's scan of it, for example Rust crates from Cargo.lock) if the workflow produces them. Exactly one of the two forms.
4. `staging-aws.sh npx tsx scripts/catalog-build.ts --sources <file> --entries local-aws@r1 --env staging --registry <host> --kms-key alias/rovara-staging-catalog-signing --evidence-dir <folder outside the repo>`: pushes the image to `svc/local-aws`, takes the SBOM and ECR scan, signs, and rewrites `catalog.json`, `catalog.sig.json` and `prepull.json` (postgres@16 is carried over; its scan must be under 30 days old). Commit the three files.

The worker pre-pull in `boot-stage2.sh` gives each image 180 s (`CATALOG_PULL_TIMEOUT_S`) and runs up to 4 at once, inside the boot deadline: a roughly 1 GB arm64 image fits when pulled from ECR in the same region, but it has not been measured on a real worker, so read the boot facts on the first staging boot.

## Evidence is not committed

`catalog-build` writes the per-image evidence (SBOMs, scans, signed statements; megabytes) to the folder given by the required `--evidence-dir`, which must be outside the repository (a path inside it is refused). Keep that folder with the release evidence. The repository holds only what is checked at run time: `catalog.json` (the combined `sbomRef` and scan per image), `catalog.sig.json` and the pre-pull list. Nothing reads the evidence files at run time. A test fails if a file over 64 KB appears under `environments/service-catalog/evidence/`.

Where the evidence lives, on the owner's Mac: revision 2 in `~/web/rovara-research-2026-10-26/test-services-evidence/2026-11-04-rev2/` (its README names the catalog hash, the signing key id and the per-image hashes); revision 3 in `.../2026-11-05-rev3/`. Revision 3 re-signs the 0.5.5 catalog (revision 2 plus slice 3's worker-image helper entries) with the same digests: only postgres@16 was re-pinned, from the same repacked index, for a fresh SBOM; local-aws@r1 is carried over. The emulator image was built by GitHub run 41848024467 of `PrepLabsAI/rovara-local-aws` (`image.yml`, fork commit `bf8d1fd5ab3fef639594796a683b430eff344e88`). The postgres@16 scan records 12 HIGH findings (0 critical), to be reviewed before use outside staging.
