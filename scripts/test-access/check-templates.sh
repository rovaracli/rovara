#!/bin/sh
# Lints the customer test account's connect kit, locally, with no AWS call: cfn-lint over the customer template, cfn-guard over it (rules in environments/test-access/rules/),
# and the generated files against their source. Pinned tools: cfn-lint 1.58.0 and cfn-guard 3.2.1.
#
#   scripts/test-access/check-templates.sh [path to a synthesized topic template to check with the topic rules]
#
# cfn-lint comes from `uv tool install cfn-lint==1.58.0` (or pip). cfn-guard is the release binary of https://github.com/aws-cloudformation/cloudformation-guard/releases/tag/3.2.1
# (cfn-guard-v3-<arch>-<os>-latest.tar.gz, sha256 of the aarch64 macOS build 4c1eb10c061731159eaaf0e7dbd465db9fa4b767b82186a4ab489671cc00b7d0) at
# ~/.local/share/rovara-tools/cfn-guard-3.2.1/cfn-guard, or any cfn-guard on PATH.
# W3037 (an action cfn-lint's snapshot of IAM does not know, or a read pattern that matches nothing in a service) is ignored: the policies are generated from AWS's own, newer, service reference.
set -eu
cd "$(dirname "$0")/../.."
TEMPLATE=environments/test-access/cloudformation/rovara-test-access.template.yaml
RULES=environments/test-access/rules
GUARD=${CFN_GUARD:-$HOME/.local/share/rovara-tools/cfn-guard-3.2.1/cfn-guard}
[ -x "$GUARD" ] || GUARD=$(command -v cfn-guard || true)
[ -n "$GUARD" ] || { echo "cfn-guard is not installed (see the header of this script)" >&2; exit 2; }
command -v cfn-lint >/dev/null || { echo "cfn-lint is not installed (see the header of this script)" >&2; exit 2; }
case $(cfn-lint --version) in *1.58.0*) ;; *) echo "warning: cfn-lint is not the pinned 1.58.0: $(cfn-lint --version)" >&2 ;; esac
case $("$GUARD" --version) in *3.2.1*) ;; *) echo "warning: cfn-guard is not the pinned 3.2.1: $("$GUARD" --version)" >&2 ;; esac

cfn-lint --ignore-checks W3037 -- "$TEMPLATE"
"$GUARD" validate --rules "$RULES/rovara-test-access.guard" --data "$TEMPLATE" --show-summary fail
if [ $# -ge 1 ]; then
  "$GUARD" validate --rules "$RULES/rovara-callback-topic.guard" --data "$1" --show-summary fail
fi
npx tsx scripts/test-access/build-artifacts.ts --check
echo "test access kit: ok"
