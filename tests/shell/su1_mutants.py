#!/usr/bin/env python3
"""Mutation runner: fresh scratch source copies, positive control per killer.
Never edits the real script. Linux mode includes the Mac-capable controls.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / 'scripts/staging-checks/setup-agent-su1.sh'
parser = argparse.ArgumentParser()
parser.add_argument('--linux', action='store_true')
args = parser.parse_args()
if 'TMPDIR' not in os.environ:
    raise SystemExit('Set TMPDIR to a session scratch directory')
source = SOURCE.read_text()
# name, exact single replacement, replacement, behavioral killer
local = [
    ('total-format', '[[ ! "$SU1_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]]', 'false', 'test_invalid_limits_refuse'),
    ('total-min', '$SU1_TIMEOUT_SECONDS -lt 10 || ', '', 'test_invalid_limits_refuse'),
    ('total-max', '$SU1_TIMEOUT_SECONDS -gt 900', '$SU1_TIMEOUT_SECONDS -gt 999', 'test_invalid_limits_refuse'),
    ('command-format', '[[ ! "$SU1_DOCKER_TIMEOUT_SECONDS" =~ ^[1-9][0-9]?$ ]]', 'false', 'test_invalid_limits_refuse'),
    ('command-max', '$SU1_DOCKER_TIMEOUT_SECONDS -gt 60', '$SU1_DOCKER_TIMEOUT_SECONDS -gt 99', 'test_invalid_limits_refuse'),
    ('expired-budget', '[[ $remaining -gt 0 ]] || return 124', ':', 'test_helper_budget'),
    ('remaining-cap', '(( limit <= remaining )) || limit=$remaining', ':', 'test_helper_budget'),
    ('reserve-time', 'remaining=$((remaining - 6))', 'remaining=$remaining', 'test_helper_budget'),
    ('cleanup-reserve', '  SU1_CLEANING=1', '  SU1_CLEANING=0', 'test_cleanup_reserve'),
    ('dk-deadline', 'timeout --foreground --kill-after=1 "$limit" "$DOCKER" "$@"', '"$DOCKER" "$@"', 'test_all_docker_paths_bounded'),
    ('cleanup-ps', 'ids=$(dk ps ', 'ids=$("$DOCKER" ps ', 'test_all_docker_paths_bounded'),
    ('cleanup-rm', '|| dk rm -f $ids', '|| "$DOCKER" rm -f $ids', 'test_all_docker_paths_bounded'),
    ('cleanup-network-ls', '  ids=$(dk network ls ', '  ids=$("$DOCKER" network ls ', 'test_all_docker_paths_bounded'),
    ('cleanup-network-rm', '|| dk network rm $ids', '|| "$DOCKER" network rm $ids', 'test_all_docker_paths_bounded'),
    ('facts-deadline', '&& dk version ', '&& "$DOCKER" version ', 'test_all_docker_paths_bounded'),
    ('inventory-deadline', 'do dk network inspect --format ', 'do "$DOCKER" network inspect --format ', 'test_all_docker_paths_bounded'),
    ('probe-deadline', '  dk run --rm ', '  "$DOCKER" run --rm ', 'test_all_docker_paths_bounded'),
]
linux = [
    ('signal-status', 'exec timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))"', 'timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))"', 'test_linux_manual_signal'),
    ('inner-foreground', 'timeout --foreground --kill-after=1 "$limit"', 'timeout --kill-after=1 "$limit"', 'test_linux_outer_group'),
    ('inner-kill', 'timeout --foreground --kill-after=1 "$limit"', 'timeout --foreground "$limit"', 'test_linux_command_deadlines'),
    ('outer-foreground', 'timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))"', 'timeout --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))"', 'test_linux_outer_group'),
    ('outer-kill', 'timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))"', 'timeout --foreground "$((SU1_TIMEOUT_SECONDS - 1))"', 'test_linux_supervisor'),
    ('outer-deadline', 'timeout --foreground --kill-after=1 "$((SU1_TIMEOUT_SECONDS - 1))" ', '', 'test_linux_supervisor'),
]
if args.linux:
    import su1_deadlines
    if not su1_deadlines.LINUX:
        raise SystemExit('Linux mutants require Linux/GNU timeout; NOT RUN')
mutants = local + (linux if args.linux else [])
controls = set()
with tempfile.TemporaryDirectory(prefix='su1-script-fix-mutants-', dir=os.environ['TMPDIR']) as temp:
    for name, old, new, test in mutants:
        # Each case bounds, kills and joins its children. Do not terminate the
        # harness mid-teardown (escaped process-group mutants need that cleanup).
        cmd = [sys.executable, str(HERE/'su1_deadlines.py'), 'Tests.'+test, '-f']
        if test not in controls:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode or 'skipped' in result.stderr:
                raise SystemExit('CONTROL FAILED '+test+'\n'+result.stdout+result.stderr)
            controls.add(test)
            print('CONTROL PASS '+test, flush=True)
        assert source.count(old) == 1, (name, source.count(old))
        copy = Path(temp)/(name+'.sh')
        copy.write_text(source.replace(old,new,1))
        assert not os.path.samestat(copy.stat(),SOURCE.stat()) and not copy.is_symlink()
        result = subprocess.run(cmd+['--source',str(copy)], capture_output=True, text=True)
        # Syntax errors, skipped cases, or infrastructure errors never count as kills.
        if result.returncode != 1 or 'FAIL:' not in result.stderr or 'ERROR:' in result.stderr or 'skipped' in result.stderr:
            raise SystemExit('MUTANT NOT KILLED '+name+'\n'+result.stdout+result.stderr)
        print('KILLED '+name+' by '+test, flush=True)
print(f'{len(mutants)} mutants killed; {len(controls)} clean controls', flush=True)
if not args.linux:
    print('Linux: pending 9d (6 signal/supervisor mutants NOT RUN)', flush=True)
