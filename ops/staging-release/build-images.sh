#!/usr/bin/env bash
# Build stage, step 1 (runs beside the repo's code in the privileged Build project; cwd = the checkout of the released commit).
# Worker and slack images: reused when this tree already has its `tree-<tree12>` tag in ECR, otherwise built (linux/arm64) and pushed with NEW unique tags only
# (`pipe-<exec8>-<sha9>` and the tree tag). It never overwrites a tag. Writes out/images.json and out/image-args.txt (the --worker-image / --slack-image arguments).
# Ported from the Mac's images/build-images.sh. Needs docker with buildx (the Build project is privileged) and ECR push rights (the Build role has them; nobody else does).
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
pack_init
need_env EXEC_ID RELEASE_SHA VERSION
require_account

TREE="$(git rev-parse HEAD^{tree})"
[ "$(git rev-parse HEAD)" = "$RELEASE_SHA" ] || refuse "HEAD is not the released commit"
TREE12="${TREE:0:12}"
TREE_TAG="tree-${TREE12}"
UNIQUE_TAG="pipe-${EXEC8}-${RELEASE_SHA:0:9}"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
# repo, dockerfile, the images.json key
IMAGES="agentx-${ENVIRONMENT}/worker environments/base/Dockerfile worker
agentx-${ENVIRONMENT}/slack environments/slack/Dockerfile slack"

image_digest_for_tag() { # repo tag -> digest or empty
  local doc
  doc="$(ro ecr describe-images --repository-name "$1" --image-ids "imageTag=$2" 2>/dev/null)" || return 0
  printf '%s' "$doc" | jq -r '.imageDetails[0].imageDigest // empty'
}

mkdir -p "$RUN_DIR"
records='[]'
logged_in=0
while read -r repo dockerfile key; do
  [ -n "$repo" ] || continue
  [ -z "$(image_digest_for_tag "$repo" "$UNIQUE_TAG")" ] || refuse "$repo:$UNIQUE_TAG already exists (a tag is never reused)"
  digest="$(image_digest_for_tag "$repo" "$TREE_TAG")"
  source=reused
  if [ -z "$digest" ]; then
    source=built
    [ -f "$dockerfile" ] || refuse "no $dockerfile in the checkout"
    if [ "$logged_in" = 0 ]; then
      a ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
      logged_in=1
    fi
    meta="$RUN_DIR/push-${key}.meta.json"
    docker buildx build --platform linux/arm64 --provenance=false --sbom=false --file "$dockerfile" \
      --tag "$REGISTRY/$repo:$UNIQUE_TAG" --tag "$REGISTRY/$repo:$TREE_TAG" --push --metadata-file "$meta" . > "$RUN_DIR/push-${key}.log" 2>&1 || refuse "the $key image build failed (see push-${key}.log)"
    digest="$(jq -r '."containerimage.digest" // empty' "$meta")"
  fi
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || refuse "no usable digest for $repo"
  # Read the image back from ECR: its tags must include this tree's tag (the evaluator's rule I checks the same thing from ECR again).
  tags="$(ro ecr describe-images --repository-name "$repo" --image-ids "imageDigest=$digest" | jq -c '.imageDetails[0].imageTags // []')"
  printf '%s' "$tags" | jq -e --arg t "$TREE_TAG" 'index($t) != null' >/dev/null || refuse "$repo@$digest does not carry the tag $TREE_TAG"
  records="$(printf '%s' "$records" | jq -c --arg repo "$repo" --arg digest "$digest" --arg source "$source" --arg key "$key" --arg uri "$REGISTRY/$repo@$digest" '. + [{repo: $repo, digest: $digest, source: $source, key: $key, uri: $uri}]')"
done <<EOF
$IMAGES
EOF
[ "$logged_in" = 0 ] || docker logout "$REGISTRY" >/dev/null 2>&1 || true
printf '%s\n' "$records" | jq . > "$RUN_DIR/images.json"
{
  jq -r '.[] | select(.key == "worker") | "--worker-image " + .uri' "$RUN_DIR/images.json"
  jq -r '.[] | select(.key == "slack") | "--slack-image " + .uri' "$RUN_DIR/images.json"
} | tr '\n' ' ' > "$RUN_DIR/image-args.txt"
echo "images: $(jq -r '.[] | .key + "=" + .source' "$RUN_DIR/images.json" | tr '\n' ' ')"
