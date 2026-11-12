# The handler of the live test of the sandbox controller (slice 4, lane W1). It runs under AWS's own python runtime client, behind lane A1's real agent, inside the gVisor sandbox. Its events are small commands (echo, sleep,
# alloc, tmpwrite, probe, exit) so the live test can look at the sandbox from the inside. The event is a dict: {"op": ...}.
import os
import socket
import subprocess
import shutil
import time


def can(fn):
    try:
        fn()
        return True
    except Exception as e:  # noqa: BLE001
        return "%s:%s" % (type(e).__name__, getattr(e, "errno", ""))


def probe():
    result = {"uid": os.getuid(), "gid": os.getgid(), "pid": os.getpid()}
    result["write_root"] = can(lambda: open("/probe-root", "w").write("x"))
    result["write_var_task"] = can(lambda: open("/var/task/probe", "w").write("x"))
    result["write_opt"] = can(lambda: open("/opt/probe", "w").write("x"))
    result["write_agent"] = can(lambda: open("/rovara/agent", "a").write("x"))
    result["write_tmp"] = can(lambda: open("/tmp/probe", "w").write("x"))

    def exec_tmp():
        shutil.copy("/bin/true", "/tmp/true-copy")
        os.chmod("/tmp/true-copy", 0o755)
        subprocess.run(["/tmp/true-copy"], check=True)

    result["exec_tmp"] = can(exec_tmp)
    result["interfaces"] = sorted(line.split(":")[0].strip() for line in open("/proc/net/dev").read().splitlines()[2:])

    def connect():
        s = socket.socket()
        s.settimeout(2)
        s.connect(("1.1.1.1", 53))
        s.close()

    result["connect_internet"] = can(connect)
    result["dns"] = can(lambda: socket.gethostbyname("example.com"))
    result["caps"] = [line.strip() for line in open("/proc/self/status") if line.startswith(("CapEff", "CapBnd", "NoNewPrivs"))]
    result["mounts"] = {m[1]: "%s,%s" % (m[2], m[3][:40]) for m in (line.split() for line in open("/proc/mounts")) if m[1] in ("/", "/tmp", "/var/task", "/opt", "/rovara/agent")}
    result["processes"] = len([p for p in os.listdir("/proc") if p.isdigit()])
    result["route"] = open("/proc/net/route").read().strip().splitlines()[1:]
    result["env"] = {k: v for k, v in os.environ.items() if k.startswith(("AWS_LAMBDA_", "AWS_REGION", "_HANDLER", "STAGE", "NEWLINE", "TZ", "AGENT_"))}
    return result


def handler(event, context):
    op = event.get("op", "echo")
    print("op=%s" % op)
    if op == "sleep":
        time.sleep(event["seconds"])
        return {"slept": event["seconds"]}
    if op == "alloc":
        buf = bytearray(event["mb"] * 1024 * 1024)
        for i in range(0, len(buf), 4096):
            buf[i] = 1
        return {"allocated_mb": event["mb"]}
    if op == "tmpwrite":
        try:
            with open("/tmp/big", "wb") as f:
                for _ in range(event["mb"]):
                    f.write(b"\0" * 1024 * 1024)
                f.flush()
                os.fsync(f.fileno())
            return {"wrote_mb": event["mb"], "ok": True}
        except OSError as e:
            return {"ok": False, "errno": e.errno}
    if op == "exit":
        os._exit(event.get("code", 3))
    if op == "raise":
        raise ValueError("raised on purpose")
    if op == "probe":
        return probe()
    return {"echo": event, "uid": os.getuid(), "function": context.function_name, "memory": context.memory_limit_in_mb, "stage": os.environ.get("STAGE"), "newline": os.environ.get("NEWLINE"), "handler": os.environ.get("_HANDLER")}
