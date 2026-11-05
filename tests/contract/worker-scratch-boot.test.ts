// S4-N2: worker scratch (packages/worker/src/worker-scratch.ts) rests on one fact about how the boot scripts start the worker: the worker container's own /tmp is on the container's overlay file
// system, a different device from the workspace volume, and no sandbox or devcontainer mounts it. If a boot change put /tmp on the volume (a mount onto it, a read-only root with a tmpfs or a
// volume for it, or a storage driver that keeps the root file system as a plain folder of the volume), every task on a worker would be refused at start. These tests pin the boot scripts to that fact,
// so the change fails here, in review, and not on a worker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(new URL(`../../packages/worker/ec2/${name}`, import.meta.url), "utf8");
const stage2 = read("boot-stage2.sh");
const SCRIPTS = [["boot.sh", read("boot.sh")], ["boot-stage2.sh", stage2], ["boot-legacy.sh", read("boot-legacy.sh")]] as const;
// The worker's own `docker run` is built by the launcher the boot writes; the catalog check's `docker run --read-only` earlier in the script is not the worker.
const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(stage2)?.[1] ?? "";
// Everything the launcher adds to the worker's arguments, one entry per line that builds `args`.
const argumentLines = launcher.split("\n").filter((line) => /^\s*(args=\(|args\+=\()/.test(line) || /\bargs\+=\(/.test(line));

describe("S4-N2: the boot scripts keep the worker container's /tmp off the workspace volume", () => {
  it("finds the launcher and its docker run arguments (the checks below read real text)", () => {
    expect(launcher).toContain('args=(run --rm --name "$WORKER_CONTAINER"');
    expect(launcher).toContain('exec "$docker" "${args[@]}"');
    expect(argumentLines.length).toBeGreaterThanOrEqual(4);
  });

  it("gives the worker no read-only root, no tmpfs and no mount onto /tmp or /var/tmp", () => {
    const text = argumentLines.join("\n");
    expect(text).not.toMatch(/--read-only/);
    expect(text).not.toMatch(/--tmpfs/);
    for (const flag of text.matchAll(/(?:--volume|--mount|(?<![\w-])-v)[ =]+("[^"]*"|'[^']*'|\S+)/g)) {
      const target = String(flag[1]).replace(/^["']|["']$/g, "");
      // A volume is `source:target[:options]`; a --mount is `key=value,...`. Either way no part of it names a temporary directory.
      expect(target, `mount ${target}`).not.toMatch(/(^|[:,=])\/(var\/)?tmp(\/|[:,]|$)/);
    }
  });

  it("mounts only the workspace, the runtime folder, the test-services run folder and the Docker socket", () => {
    const targets = [...argumentLines.join("\n").matchAll(/--volume "([^"]+)"/g)].map((match) => String(match[1]));
    expect(targets).toEqual(['$MOUNT_PATH:$MOUNT_PATH', '$RUNTIME_ROOT:$RUNTIME_ROOT', '$TEST_SERVICES_RUN_DIR:$TEST_SERVICES_RUN_DIR', '$DOCKER_SOCKET:$DOCKER_SOCKET']);
  });

  it("sets the worker's TMPDIR only to the runtime folder's tmp or to the container's own /tmp", () => {
    const values = [...launcher.matchAll(/TMPDIR=("[^"]*"|[^\s)]+)/g)].map((match) => String(match[1]).replace(/^"|"$/g, ""));
    expect(values.sort()).toEqual(["$RUNTIME_ROOT/tmp", "/tmp"]);
  });

  it.each(SCRIPTS)("%s writes Docker's daemon.json with a data root and never a storage driver (a driver such as vfs would keep the container root on the volume)", (_name, script) => {
    const writes = script.split("\n").filter((line) => line.includes("/etc/docker/daemon.json"));
    // boot.sh and boot-legacy.sh write it once; boot-stage2.sh rewrites it with the address pools; every write is the data root (and the pools).
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes) {
      expect(line).toContain('"data-root"');
      expect(line).not.toMatch(/storage-driver|storage-opts|"userns-remap"/);
    }
    expect(script).not.toMatch(/--storage-driver|storage-driver/);
  });

  it("keeps the runtime folder's tmp (the same device as the workspace) named only for the verifier-ready case, where worker scratch skips it", () => {
    // `TMPDIR=$RUNTIME_ROOT/tmp` is on the workspace device, so chooseScratch skips it and takes /tmp. That is only so if the runtime folder is a bind mount of a folder of the workspace.
    expect(stage2).toContain("RUNTIME_SOURCE=/mnt/workspace/.agentx-runtime");
    expect(stage2).toContain('mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT"');
  });
});
