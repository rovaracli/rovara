#!/usr/bin/env python3
"""Committed harness for sequential SU-1 guard mutations in scratch copies.
Run from the repository root (requires installed dependencies):
  SU1_SCRATCH=$(mktemp -d "${TMPDIR:?}/su1-boot-check.XXXXXX")
  TMPDIR="$SU1_SCRATCH" ~/.local/share/rovara-tools/heavy.sh python3 tests/shell/su1_boot_mutants.py
  rmdir "$SU1_SCRATCH"
Optional SU1_MUTANTS is a comma-separated subset, e.g. elapsed-seconds;
SU1_TEST_NODE selects a Node executable. Each selector runs a clean control first.
Boot mutants use SU1_BOOT_TEST_SOURCE to read an independent scratch script;
TypeScript mutants use a temporary Vite transform. Only copies are mutated.
No git history, network, Docker or mutation of production files. Scratch copies
are removed after synchronous children finish; the harness itself is committed.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
if not os.environ.get('TMPDIR'):
    raise SystemExit('TMPDIR must name a session scratch directory')
NODE = os.environ.get('SU1_TEST_NODE') or shutil.which('node')
BOOT = 'packages/worker/ec2/boot-stage2.sh'
PARSER = 'packages/worker/src/su1-check.ts'
LAUNCH = 'packages/broker/src/aws/private-address-launch.ts'
IAM = 'infra/lib/session-lifecycle.ts'
BT = 'tests/contract/ec2-boot-su1-check.test.ts'
PT = 'tests/unit/worker-su1-check.test.ts'
LT = 'tests/contract/private-address-wall.test.ts'
IT = 'tests/contract/tsl-selftest-grant.test.ts'
# name, module, old, new, test file, literal test-name selector
MUTANTS = [
 ('elapsed-seconds', BOOT, 'su1_record "$state" "$reason" $((SECONDS - started))', 'su1_record "$state" "$reason" 0', BT, 'records elapsed wall'),
 ('off', BOOT, 'tsl_selftest_gate "${AGENTX_SU1_CHECK:-}"', 'tsl_selftest_gate "1"', BT, 'off creates'),
 ('named', BOOT, 'if [[ "${AGENTX_ENVIRONMENT_KIND:-}" != named ]]; then TSL_GATE=refused', 'if false; then TSL_GATE=refused', BT, 'refuses.*legacy'),
 ('staging', BOOT, 'if [[ "$TSL_ENVIRONMENT" != "$TSL_ALLOWED_ENVIRONMENT" ]]; then', 'if false; then', BT, 'refuses.*production'),
 ('registry-account', BOOT, '[[ "${registry%%.*}" == "$allowed" ]] || return 1', 'true', BT, 'refuses.*AGENTX_WORKER_IMAGE'),
 ('instance-account', BOOT, '[[ "$account" == "$allowed" ]]', 'true', BT, 'refuses.*ACCOUNT'),
 ('image-flavor', BOOT, '! grep -Fq \'CATALOG_BUILD_FLAVOR = "staging";\' "$dir/flavor.js"; then\n    su1_finish', 'false; then\n    su1_finish', BT, 'refuses.*release'),
 ('boot-budget', BOOT, 'if ((budget < 45)); then su1_record', 'if ((budget < -10000)); then su1_record', BT, 'declines when'),
 ('command-deadline', BOOT, '((left > 0)) || return 124', 'true', BT, 'never runs Docker'),
 ('command-cap', BOOT, '((cap <= left)) || cap=$left', 'true', BT, 'KILL reserve'),
 ('group-kill', BOOT, 'SU1_DOCKER_TIMEOUT_SECONDS=15 timeout --kill-after=2s', 'SU1_DOCKER_TIMEOUT_SECONDS=15 timeout --foreground --kill-after=2s', BT, 'whole-group'),
 ('kill-escalation', BOOT, 'SU1_DOCKER_TIMEOUT_SECONDS=15 timeout --kill-after=2s', 'SU1_DOCKER_TIMEOUT_SECONDS=15 timeout', BT, 'whole-group'),
 ('ordered-readback', BOOT, 'cmp -s "$SU1_BEFORE" "$SU1_AFTER"', 'true', BT, 'fails closed on.*LEAK_RULE'),
 ('marker-strict', BOOT, 'if [[ ! -e "$SU1_MARKER_FILE" ]]; then', 'if true; then', BT, 'crash marker'),
 ('pending-9', BOOT, '[[ "$id" == 9 || "$id" == 10 ]]', '[[ "$id" == 10 ]]', BT, 'retains failed'),
 ('pending-10', BOOT, '[[ "$id" == 9 || "$id" == 10 ]]', '[[ "$id" == 9 ]]', BT, 'retains failed'),
 ('erase-lock', BOOT, 'rm -f "$SU1_LOCK_FILE" /var/tmp/agentx-su1-check.lock', ':', BT, 'control: a clean run'),
 ('cleanup-fatal', BOOT, 'rm -f "$SU1_BEFORE" "$SU1_AFTER"; return 75', 'rm -f "$SU1_BEFORE" "$SU1_AFTER"; return 0', BT, 'fails closed on.*LEAK_CONTAINER'),
 ('gnu-timeout', BOOT, 'if [[ "$(timeout --version 2>/dev/null)" != \'timeout (GNU coreutils)\'* ]]; then', 'if false; then', BT, 'requires GNU timeout'),
 ('parser-size', PARSER, 'if (text.length > 3_000)', 'if (text.length > 30_000)', PT, 'rejects extra'),
 ('parser-keys', PARSER, 'Object.keys(value).length !== KEYS.length', 'false', PT, 'rejects extra'),
 ('parser-version', PARSER, 'value.v !== 1', 'false', PT, 'rejects extra'),
 ('parser-number', PARSER, '!Number.isInteger(value.secs)', 'false', PT, 'rejects extra'),
 ('parser-pending', PARSER, '(i === 8 || i === 9)', 'false', PT, 'rejects duplicate'),
 ('parser-false-pass', PARSER, 'if ((status === "pass") !== (reason === "ok"))', 'if (false)', PT, 'rejects duplicate'),
 ('switch-exact', LAUNCH, 'if (value === "true") return true;\n    if (value !== "false") log(JSON.stringify({ component: "session-steps", event: "su1_check', 'if (value !== "false") return true;\n    if (value !== "false") log(JSON.stringify({ component: "session-steps", event: "su1_check', LT, 'SU-1 self-test switch reader.*off for false'),
 ('launch-prefix', LAUNCH, 'su1Check.settingsPrefix === TSL_SELFTEST_ALLOWED_PREFIX', 'true', LT, "SU-1 check switch.*byte-identical"),
 ('launch-named', LAUNCH, 'su1Check !== undefined && config.environmentKind === "named"', 'su1Check !== undefined', LT, 'SU-1 check switch.*not added'),
 ('iam-condition', IAM, '(tslSelftestRead.node.defaultChild as iam.CfnPolicy).cfnOptions.condition = isStaging;', 'void isStaging;', IT, 'two boot switches'),
 ('iam-extra-action', IAM, 'statements: [new iam.PolicyStatement({\n          actions: ["ssm:GetParameter"],', 'statements: [new iam.PolicyStatement({\n          actions: ["ssm:GetParameter", "ssm:PutParameter"],', IT, 'two boot switches'),
 ('iam-extra-resource', IAM, 'parameter${naming.ec2.workerSettingsPrefix}su1-check`,', 'parameter${naming.ec2.workerSettingsPrefix}su1-check`, "*",', IT, 'two boot switches'),
]
# The cap test uses syntactically valid oversized JSON, so JSON.parse cannot
# accidentally act as the size guard's killer.
MUTANTS += [
 ('empty-switch-no-fallback', BOOT, '${1-${AGENTX_TSL_SELFTEST:-}}', '${1:-${AGENTX_TSL_SELFTEST:-}}', BT, 'off creates'),
 ('partial-temp-cleanup', BOOT, 'rm -rf "$SU1_BEFORE" "$SU1_AFTER" "${dir:-}"', ':', BT, 'partially created snapshot'),
 ('read-staging-only', 'packages/broker/src/aws/session-steps.ts', 'return tslSelftestWiredFor(namedEnvironment, settingsPrefix);', 'return true;', 'tests/contract/session-steps.test.ts', 'carries the SU-1 check switch'),
 ('parser-state-word', PARSER, '!oneOf(SU1_CHECK_STATES, value.state)', 'false', PT, 'rejects extra'),
 ('parser-reason-word', PARSER, '!oneOf(SU1_CHECK_REASONS, value.reason)', 'false', PT, 'rejects extra'),
 ('parser-identities', PARSER, '(value === "unknown" || pattern.test(value))', 'true', PT, 'rejects extra'),
 ('parser-seconds-range', PARSER, 'value.secs < 0 || value.secs > 9_999', 'false', PT, 'rejects extra'),
 ('parser-row-count', PARSER, 'value.items.length !== 11', 'false', PT, 'rejects duplicate'),
 ('parser-row-reason', PARSER, '!oneOf(SU1_CHECK_REASONS, reason)', 'false', PT, 'rejects duplicate'),
 ('duplicate-row', BOOT, 'if (count == 1) print s', 'if (count >= 1) print s', BT, 'duplicate checker rows'),
 ('cleanup-label', BOOT, 'readonly SU1_LABEL=agentx.su1-check', 'readonly SU1_LABEL=agentx.other-check', BT, 'control: a clean run'),
 ('empty-bundle', BOOT, ' || [[ ! -s "$dir/s.sh" ]]', '', BT, 'empty image bundle'),
 ('marker-before-object', BOOT, "printf 'su1-check\\n' >\"$SU1_MARKER_FILE\"", ':', BT, 'control: a clean run'),
 ('main-cleanup-fatal', BOOT, '((su1_status == 0)) || fail', '((1 == 1)) || fail', BT, 'real main fails'),
]
selected = os.environ.get('SU1_MUTANTS')
if selected:
    wanted = set(selected.split(','))
    assert wanted <= {m[0] for m in MUTANTS}, 'unknown mutant name'
    MUTANTS = [m for m in MUTANTS if m[0] in wanted]
controls = set()
with tempfile.TemporaryDirectory(prefix='su1-boot-check-mutants-', dir=os.environ['TMPDIR']) as temp:
    scratch = Path(temp)
    config = scratch / 'mutation.config.mts'
    config.write_text('import base from ' + json.dumps(str(ROOT/'vitest.config.ts')) + ';\n'
        'import { readFileSync } from "node:fs";\n'
        'export default {...base, plugins: [{ name: "su1-scratch-mutation", enforce: "pre",\n'
        'transform(code, id) { if (id === process.env.SU1_MUTANT_MODULE) return {code: readFileSync(process.env.SU1_MUTANT_SOURCE, "utf8"), map: null}; } }]};\n')
    for name, module, old, new, test, selector in MUTANTS:
        source = (ROOT/module).read_text()
        assert source.count(old) == 1, (name, source.count(old))
        cmd = [NODE, str(ROOT/'node_modules/vitest/vitest.mjs'), 'run', test, '--maxWorkers=4', '-t', selector]
        key = (test, selector)
        if key not in controls:
            result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            log = result.stdout + result.stderr
            if result.returncode or 'passed' not in log:
                raise SystemExit('CONTROL FAILED '+name+'\n'+log)
            controls.add(key)
            print('CONTROL PASS '+selector, flush=True)
        copy = scratch / (name + Path(module).suffix)
        copy.write_text(source.replace(old, new, 1))
        assert not os.path.samestat(copy.stat(), (ROOT/module).stat()) and not copy.is_symlink()
        env = dict(os.environ)
        if module == BOOT:
            env['SU1_BOOT_TEST_SOURCE'] = str(copy)
        else:
            env.update(SU1_MUTANT_MODULE=str(ROOT/module), SU1_MUTANT_SOURCE=str(copy))
        result = subprocess.run(cmd + ['--config', str(config)], cwd=ROOT, env=env, capture_output=True, text=True)
        log = result.stdout + result.stderr
        if result.returncode != 1 or 'AssertionError:' not in log or 'Tests  ' not in log or 'Unhandled Errors' in log:
            raise SystemExit('MUTANT NOT KILLED '+name+'\n'+log)
        print('KILLED '+name+' by '+selector, flush=True)
print(str(len(MUTANTS))+' mutants killed; '+str(len(controls))+' clean controls', flush=True)
print('GNU signal execution remains a separate Linux coordinator gate.', flush=True)
