#!/usr/bin/env python3
"""Offline SU1 shell harness. No Docker/socket, root, or network access.

Only a fresh scratch copy is path-translated; the production PATH and DOCKER
pin remain intact. Mac uses a transparent timeout stand-in for golden/wiring
checks; real signals, deadlines and /proc assertions run ONLY on Linux/GNU.
"""
import argparse
import json
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

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / 'scripts/staging-checks/setup-agent-su1.sh'
GNU = shutil.which('timeout')
LINUX = sys.platform == 'linux' and GNU is not None and 'GNU coreutils' in subprocess.run(
    [GNU, '--version'], capture_output=True, text=True, check=False).stdout
# Must be explicitly supplied: never silently choose a shared scratch directory.
SCRATCH = os.environ.get('TMPDIR')
if not SCRATCH:
    raise SystemExit('Set TMPDIR to a writable session scratch directory')

FAKE = r"""#!PYTHON
import json, os, signal, sys, time
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
root=Path(os.environ['SU1_TEST_ROOT'])
if name == 'timeout':
    while args and args[0].startswith('--'): args.pop(0)
    duration=args.pop(0)
    with (root/'timeouts').open('a') as f: f.write(json.dumps([duration,args[0]])+'\n')
    os.environ['SU1_TEST_BOUND']=Path(args[0]).name
    os.environ['SU1_TEST_DURATION']=duration
    os.execvp(args[0],args)
if name == 'docker':
    key=' '.join(args[:2]) if args[:1] == ['network'] else args[0]
    with (root/'calls').open('a') as f:
        f.write(json.dumps([key,args,os.getpid(),os.getpgrp(),os.environ.get('SU1_TEST_BOUND')])+ '\n')
    target=os.environ.get('SU1_TEST_HANG','')
    cleanup=any('label=agentx.su1-check=' in x for x in args)
    match=target == key or (target == 'probe' and key == 'run' and '--rm' in args) or (target == 'cleanup' and cleanup)
    if match:
        if os.environ.get('SU1_TEST_RESIST') == '1': signal.signal(signal.SIGTERM,signal.SIG_IGN)
        (root/'ready').write_text(str(os.getpid()))
        while True: time.sleep(0.1)
    if os.environ.get('SU1_TEST_SLOW') == '1': time.sleep(0.45)
    if key == 'network create':
        bridge=next(x.split('=',1)[1] for x in args if x.startswith('com.docker.network.bridge.name='))
        (root/'sys/class/net'/bridge).mkdir(exist_ok=True)
    elif key == 'version': print('25.fixture')
    elif key == 'ps' and '-q' in args: print('fixture-container')
    elif key == 'network ls' and '-q' in args: print('fixture-network')
    elif key == 'network inspect': print('192.0.2.0/24')
    elif key == 'inspect': print('true')
    elif key == 'run' and '--rm' in args or key == 'exec' and '-e' in args:
        cfg=json.loads(args[-1])
        for t in cfg['tests']:
            label=t['label']
            if label in ('pub_udp','pub_tcp'): val='answer rcode=0 an=1'
            elif label in ('nx_udp','nx_tcp','up_nx'): val='answer rcode=3 an=0'
            elif label == 'lookup_pub': val='resolved 192.0.2.1'
            elif label == 'resolv': val='file '+json.dumps('nameserver 127.0.0.11\n# ExtServers: [172.29.250.2]')
            elif label == 'imds_80': val='ECONNREFUSED'
            else: val='timeout'
            print(label+' '+val)
    elif key == 'exec': print('{"su1-010203040506.invalid":1}')
    sys.exit(0)
if name == 'hostname': print('fixture-host')
elif name == 'uname': print('Linux' if args == ['-s'] else 'fixture-kernel')
elif name == 'lsmod': print('br_netfilter 1 1')
elif name == 'ip': pass
elif name in ('flock','sleep','nft','ip6tables'): pass
elif name == 'head' and '/dev/urandom' in args: sys.stdout.buffer.write(bytes([1,2,3,4,5,6]))
elif name == 'head': os.execv(os.environ['SU1_TEST_HEAD'],[os.environ['SU1_TEST_HEAD']]+args)
elif name == 'sha256sum':
    import hashlib
    print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()+'  -')
elif name == 'iptables':
    if args == ['-S','DOCKER-USER']:
        print('''-A DOCKER-USER -d 169.254.169.254/32 -j REJECT
-A DOCKER-USER -i rvbs+ -o rvbs+ --ctstate ESTABLISHED -j RETURN
-A DOCKER-USER -i rvbs+ -o rvbs+ -m physdev -d 172.29.0.0/16 -p udp --dport 53 -j RETURN
-A DOCKER-USER -i rvbs+ -o rvbs+ -m physdev -d 172.29.0.0/16 -p tcp --dport 53 -j RETURN
-A DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p udp --dport 53 -j DROP
-A DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p tcp --dport 53 -j DROP
-A DOCKER-USER -d 172.16.0.0/12 -j DROP
-A DOCKER-USER -d 10.0.0.0/8 -j DROP''')
    elif args == ['-S','INPUT']: print('-A INPUT -i rvb+ -j DROP')
    elif args == ['-S','FORWARD']: print('-A FORWARD -j DOCKER-USER\n-A FORWARD -j DOCKER-ISOLATION-STAGE-1')
else: raise SystemExit('unexpected fake tool: '+name)
"""


def live(pid):
    """Linux zombies are terminated, not surviving clients; never signal reuse."""
    try:
        if sys.platform == 'linux':
            return Path(f'/proc/{pid}/stat').read_text().split(') ')[1][0] != 'Z'
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, FileNotFoundError):
        return False


class Harness:
    def __init__(self, text, real_timeout=False):
        self.temp = tempfile.TemporaryDirectory(prefix='su1-script-fix-', dir=SCRATCH)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for tool in ('docker','hostname','uname','lsmod','ip','flock','sleep','head','iptables','ip6tables','nft','sha256sum'):
            p = self.bin / tool
            p.write_text(FAKE.replace('PYTHON', sys.executable, 1))
            p.chmod(0o700)
        if real_timeout:
            (self.bin/'timeout').symlink_to(GNU)
        else:
            p = self.bin / 'timeout'
            p.write_text(FAKE.replace('PYTHON', sys.executable, 1))
            p.chmod(0o700)
        # Filesystem/privilege adaptations only; never change deadline logic.
        for path in ('/etc/agentx','/proc/sys','/sys/class/net','/run/lock','/var/tmp','/etc/resolv.conf','/run/systemd/resolve'):
            text = text.replace(path, str(self.root) + path)
        for path in ('etc/agentx','proc/sys/net/bridge','sys/class/net','run/lock','var/tmp','run/systemd/resolve'):
            (self.root / path).mkdir(parents=True, exist_ok=True)
        (self.root/'etc/agentx/docker-path').write_text(str(self.bin/'docker'))
        (self.root/'etc/agentx/worker-image').write_text('fixture-image')
        (self.root/'etc/agentx/worker.env').write_text('AGENTX_SANDBOX_IMAGE=fixture-sandbox\n')
        (self.root/'proc/sys/net/bridge/bridge-nf-call-iptables').write_text('1\n')
        (self.root/'etc/resolv.conf').write_text('')
        pinned = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        assert text.count(pinned) == 1, 'production PATH pin changed'
        text = text.replace(pinned, 'PATH=' + str(self.bin) + ':/usr/bin:/bin')
        assert text.count('$EUID -ne 0') == 1
        text = text.replace('$EUID -ne 0', '0 -ne 0')
        self.script = self.root / 'script.sh'
        self.script.write_text(text)
        self.env = {'PATH':'/usr/bin:/bin', 'LC_ALL':'C', 'SU1_TEST_ROOT':str(self.root),
                    'SU1_TEST_HEAD':shutil.which('head')}
        self.proc = None

    def start(self, group_member=False, **env):
        command = ['/bin/bash', str(self.script)]
        if group_member:
            # Script is NOT the group leader: default GNU timeout would escape
            # this caller-owned group, even when the script execs timeout.
            command = ['/bin/bash', '-c', '"$@"; rc=$?; exit "$rc"', 'caller'] + command
        self.proc = subprocess.Popen(command, env={**self.env, **env},
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     start_new_session=True)
        return self.proc

    def run(self, limit=15, **env):
        self.start(**env)
        try:
            out, err = self.proc.communicate(timeout=limit)
        except subprocess.TimeoutExpired:
            raise AssertionError('script exceeded independent harness deadline') from None
        return self.proc.returncode, out, err

    def calls(self):
        p = self.root/'calls'
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def wait_ready(self):
        end = time.monotonic()+5
        while time.monotonic()<end:
            if (self.root/'ready').exists(): return
            if self.proc.poll() is not None: break
            time.sleep(0.02)
        raise AssertionError('fake docker never entered the requested hang')

    def owned(self):
        # Unique per-test environment marker identifies even escaped/orphaned
        # descendants. Never kill a recorded PID that may have been reused.
        if sys.platform != 'linux':
            return []
        result = []
        marker = ('SU1_TEST_ROOT='+str(self.root)).encode()
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if marker in (entry/'environ').read_bytes().split(b'\0'):
                    result.append(int(entry.name))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
        return result

    def close(self):
        if self.proc:
            if sys.platform == 'linux':
                # Freeze writers before killing, including escaped mutant groups.
                # A second scan catches children born during the first scan.
                for _ in range(2):
                    for pid in self.owned():
                        try: os.kill(pid, signal.SIGSTOP)
                        except ProcessLookupError: pass
                for pid in self.owned():
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
            elif self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.communicate(timeout=3)
            end = time.monotonic()+3
            while self.owned() and time.monotonic()<end:
                time.sleep(0.02)
            assert not self.owned(), 'test descendants still running; retaining scratch'
        self.temp.cleanup()


class Tests(unittest.TestCase):
    source = SOURCE.read_text()

    def harness(self, real=False):
        h = Harness(self.source, real)
        self.addCleanup(h.close)
        return h

    def test_golden(self):
        h = self.harness()
        before = {str(p.relative_to(h.root)) for p in h.root.rglob('*') if p.is_file()}
        rc, out, err = h.run()
        after = {str(p.relative_to(h.root)) for p in h.root.rglob('*') if p.is_file()}
        self.assertEqual(after-before, {'calls','timeouts','run/lock/agentx-su1-check.lock'})
        self.assertEqual((h.root/'run/lock/agentx-su1-check.lock').stat().st_mode & 0o777, 0o600)
        self.assertEqual(rc, 1)  # checks 9/10 always require manual evidence
        self.assertEqual(err, '')
        self.assertEqual(out, (HERE/'su1-success.golden').read_text())
        self.assertEqual((h.root/'run/lock/agentx-su1-check.lock').read_bytes(), b'')
        self.assertTrue(any(c[0] == 'rm' for c in h.calls()))
        self.assertTrue(any(c[0] == 'network rm' for c in h.calls()))

    def test_all_docker_paths_bounded(self):
        h = self.harness()
        h.run()
        calls = h.calls()
        self.assertTrue(calls)
        self.assertEqual({c[0] for c in calls}, {'version','info','ps','rm','network ls','network rm','network inspect','network create','run','inspect','exec','stop'})
        self.assertEqual([c[0] for c in calls if c[4] != 'docker'], [])

    def test_invalid_limits_refuse(self):
        for name, vals in [('SU1_TIMEOUT_SECONDS', ['','0','9','901','-1','1.5','1+9','999999999999999999999']),
                           ('SU1_DOCKER_TIMEOUT_SECONDS', ['','0','61','-1','1.5','1+1'])]:
            for val in vals:
                with self.subTest(name=name, val=val):
                    h = self.harness()
                    rc, out, _ = h.run(**{name:val})
                    self.assertEqual(rc, 2)
                    self.assertTrue(out.startswith('SU1 ERROR '))
                    self.assertEqual(h.calls(), [])

    def test_limit_endpoints(self):
        for total, command in [('10','1'),('900','60')]:
            h = self.harness()
            rc, out, err = h.run(SU1_TIMEOUT_SECONDS=total, SU1_DOCKER_TIMEOUT_SECONDS=command)
            self.assertEqual(rc, 1)
            self.assertTrue(out.startswith('SU1 START '))
            if total == '900':
                self.assertEqual(out, (HERE/'su1-success.golden').read_text())
            self.assertEqual(err, '')

    def test_cleanup_reserve(self):
        h = self.harness()
        dk = 'dk() {' + self.source.split('dk() {', 1)[1].split('\n}', 1)[0] + '\n}'
        cleanup = 'cleanup() {' + self.source.split('cleanup() {', 1)[1].split('\n}', 1)[0] + '\n}'
        code = dk + '\n' + cleanup + '\nSECONDS=0; SU1_END=7; SU1_CLEANING=0; SU1_DOCKER_TIMEOUT_SECONDS=60; SU1_LABEL=fixture; DOCKER=$1; cleanup'
        result = subprocess.run(['/bin/bash','-c',code,'cleanup',str(h.bin/'docker')],
                                env={**h.env, 'PATH':str(h.bin)+':/usr/bin:/bin'}, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual([c[0] for c in h.calls()], ['ps','rm','network ls','network rm'])

    def test_helper_budget(self):
        # Exercise the actual helper in isolation with a deterministic shell
        # clock. The command is fake, but refusal, cap and cleanup reserve are real.
        helper = self.source.split('dk() {', 1)[1].split('\n}', 1)[0]
        helper = 'dk() {' + helper + '\n}'
        for end, cleaning, rc, duration in [(0, 0, 124, None), (9, 0, 0, '2'), (4, 1, 0, '3')]:
            h = self.harness()
            code = helper + '\nSECONDS=0; SU1_END=$1; SU1_CLEANING=$2; SU1_DOCKER_TIMEOUT_SECONDS=60; DOCKER=$3; dk version'
            result = subprocess.run(['/bin/bash','-c',code,'helper',str(end),str(cleaning),str(h.bin/'docker')],
                                    env={**h.env, 'PATH':str(h.bin)+':/usr/bin:/bin'}, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, rc)
            if duration is None:
                self.assertEqual(h.calls(), [])
            else:
                self.assertEqual(result.stdout, '25.fixture\n')
                self.assertEqual(json.loads((h.root/'timeouts').read_text())[0], duration)

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout required: signal/KILL/deadline proof pending Linux runner')
    def test_linux_command_deadlines(self):
        # Each distinct path: facts, dk, former xargs, probe and all cleanup verbs.
        for target in ('version','info','network inspect','run','probe','ps','rm','network ls','network rm'):
            for resistant in ('0','1'):
                with self.subTest(target=target, resistant=resistant):
                    h = self.harness(True)
                    start = time.monotonic()
                    rc, _, _ = h.run(limit=23, SU1_TIMEOUT_SECONDS='20', SU1_DOCKER_TIMEOUT_SECONDS='1',
                                     SU1_TEST_HANG=target, SU1_TEST_RESIST=resistant)
                    self.assertNotEqual(rc, 0)
                    self.assertLess(time.monotonic()-start, 22)
                    self.assertTrue((h.root/'ready').exists(), 'hang path was never reached')
                    self.assertFalse(any(live(c[2]) for c in h.calls()), 'Docker client survived deadline')

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout required: bounded cleanup pending Linux runner')
    def test_linux_cleanup(self):
        h = self.harness(True)
        rc, _, _ = h.run(limit=13, SU1_TIMEOUT_SECONDS='10', SU1_DOCKER_TIMEOUT_SECONDS='1',
                         SU1_TEST_HANG='cleanup', SU1_TEST_RESIST='1')
        self.assertNotEqual(rc, 0)
        self.assertTrue((h.root/'ready').exists(), 'cleanup did not run')
        self.assertFalse(any(live(c[2]) for c in h.calls()))

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout required: overall deadline pending Linux runner')
    def test_linux_overall(self):
        h = self.harness(True)
        start = time.monotonic()
        rc, _, _ = h.run(limit=13, SU1_TIMEOUT_SECONDS='10', SU1_DOCKER_TIMEOUT_SECONDS='60', SU1_TEST_SLOW='1')
        self.assertNotEqual(rc, 0)
        self.assertLess(time.monotonic()-start, 12)
        self.assertFalse(any(live(c[2]) for c in h.calls()))

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout required: supervisor escalation pending Linux runner')
    def test_linux_supervisor(self):
        h = self.harness(True)
        # A TERM-resistant shell body, without a child that could hold pipes open.
        h.script.write_text(h.script.read_text().replace('# ---- host facts', "trap '' TERM; while :; do :; done\n# ---- host facts", 1))
        start = time.monotonic()
        rc, _, _ = h.run(limit=13, SU1_TIMEOUT_SECONDS='10')
        self.assertEqual(rc, 137)
        self.assertLess(time.monotonic()-start, 12)

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout required: manual signal status pending Linux runner')
    def test_linux_manual_signal(self):
        h = self.harness(True)
        p = h.start(SU1_TEST_HANG='run')
        h.wait_ready()
        os.killpg(p.pid, signal.SIGTERM)
        p.communicate(timeout=4)
        self.assertEqual(p.returncode, 130)
        self.assertEqual([c[0] for c in h.calls()[-4:]], ['ps','rm','network ls','network rm'])
        self.assertTrue(any(c[0] == 'ps' and any('label=agentx.su1-check=' in a for a in c[1]) for c in h.calls()))
        self.assertEqual(h.owned(), [])

    @unittest.skipUnless(LINUX, 'Linux/GNU timeout and /proc required: outer group kill pending Linux runner')
    def test_linux_outer_group(self):
        for resistant in ('0','1'):
            h = self.harness(True)
            p = h.start(group_member=True, SU1_TEST_HANG='run', SU1_TEST_RESIST=resistant)
            h.wait_ready()
            self.assertTrue(all(c[3] == p.pid for c in h.calls()), 'child escaped caller process group')
            os.killpg(p.pid, signal.SIGTERM)
            if resistant == '1':
                time.sleep(0.1)
                os.killpg(p.pid, signal.SIGKILL)
            p.communicate(timeout=4)
            self.assertFalse(any(live(c[2]) for c in h.calls()))
            self.assertEqual(h.owned(), [], 'a descendant survived the outer group kill')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path)
    parser.add_argument('--golden-write', action='store_true', help='baseline capture only, before implementation')
    args, extra = parser.parse_known_args()
    if args.source: Tests.source = args.source.read_text()
    if args.golden_write:
        h = Harness(Tests.source)
        try:
            rc, out, err = h.run()
            assert rc == 1 and not err, (rc, err)
            (HERE/'su1-success.golden').write_text(out)
            print(out, end='')
        finally: h.close()
    else:
        unittest.main(argv=[sys.argv[0]]+extra, verbosity=2)
