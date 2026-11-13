#!/usr/bin/env python3
"""SU-1 boot's actual timeout helpers with inert children; Linux/GNU only.
No Docker, network, root, system files or git history. Run through heavy.sh.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'packages/worker/ec2/boot-stage2.sh'
GNU = shutil.which('timeout')
LINUX = sys.platform == 'linux' and GNU is not None and 'GNU coreutils' in subprocess.run(
    [GNU, '--version'], capture_output=True, text=True, check=False).stdout
if not os.environ.get('TMPDIR'):
    raise SystemExit('TMPDIR must name a session scratch directory')


def owned(session):
    """The dedicated test session includes every timeout process group.
    Read only process metadata, never other processes' environment values.
    A surviving member keeps the kernel session id allocated.
    """
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(') ', 1)[1].split()
            if fields[0] != 'Z' and int(fields[3]) == session:
                found.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found


@unittest.skipUnless(LINUX, 'Linux/GNU timeout required; coordinator gate, not proven on Mac')
class Tests(unittest.TestCase):
    source = SOURCE.read_text()

    def exercise(self, helper, hanging):
        with tempfile.TemporaryDirectory(prefix='su1-boot-check-signals-', dir=os.environ['TMPDIR']) as temp:
            root = Path(temp)
            script = root / 's.sh'
            script.write_text('echo control\n' if not hanging else
                'trap "" TERM\n' + sys.executable + ' "$SU1_BOOT_PROCESS_ROOT/child.py" &\nwait\n')
            (root / 'child.py').write_text(
                'import os, signal, time\nfrom pathlib import Path\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'p=Path(os.environ["SU1_BOOT_PROCESS_ROOT"])/"ready"\np.write_text("ready")\n'
                'while True: time.sleep(0.05)\n')
            match = re.search(r'^' + helper + r'\(\) \{\n.*?^\}', self.source, re.M | re.S)
            self.assertIsNotNone(match)
            invoke = 'su1_run_checks 1 "$SU1_BOOT_PROCESS_ROOT" "$SU1_BOOT_PROCESS_ROOT/out"'
            if helper == 'su1_command':
                invoke = 'SU1_HARD_DEADLINE=$((SECONDS + 3)); su1_command 60 bash "$SU1_BOOT_PROCESS_ROOT/s.sh"'
            env = {'PATH': str(Path(GNU).parent) + ':/usr/bin:/bin', 'SU1_BOOT_PROCESS_ROOT': str(root)}
            start = time.monotonic()
            proc = subprocess.Popen(['/bin/bash', '-c', match.group(0) + '\n' + invoke],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                    start_new_session=True)
            try:
                try:
                    out, err = proc.communicate(timeout=7)
                except subprocess.TimeoutExpired:
                    self.fail('boot helper exceeded independent harness deadline')
                if hanging:
                    self.assertTrue((root / 'ready').exists(), 'hanging descendant never ran')
                    self.assertIn(proc.returncode, (124, 137))
                    self.assertLess(time.monotonic() - start, 6)
                    self.assertEqual(owned(proc.pid), [], 'a late writer survived before cleanup')
                else:
                    self.assertEqual(proc.returncode, 0, err)
                    result = (root / 'out').read_text() if helper == 'su1_run_checks' else out
                    self.assertEqual(result, 'control\n')
            finally:
                # Always stop and join even an escaped mutant before removing scratch.
                for _ in range(2):
                    for pid in owned(proc.pid):
                        try: os.kill(pid, signal.SIGSTOP)
                        except ProcessLookupError: pass
                for pid in owned(proc.pid):
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                proc.communicate(timeout=3)
                end = time.monotonic() + 3
                while owned(proc.pid) and time.monotonic() < end:
                    time.sleep(0.02)
                self.assertEqual(owned(proc.pid), [], 'retained descendants')

    def test_00_control(self):
        for helper in ('su1_run_checks', 'su1_command'):
            self.exercise(helper, False)

    def test_checker_group_kill(self):
        self.exercise('su1_run_checks', True)

    def test_command_group_kill(self):
        self.exercise('su1_command', True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path)
    args, rest = parser.parse_known_args()
    if args.source:
        Tests.source = args.source.read_text()
    unittest.main(argv=[sys.argv[0]] + rest, verbosity=2)
