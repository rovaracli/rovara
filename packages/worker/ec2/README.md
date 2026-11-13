# EC2 worker boot behavior

`boot.sh` is compressed into EC2 user data, so its source stays small to preserve the required 4.5 KB
reserve. The details below document its operational boundaries without adding bytes to the executable
bootstrap.

## Two stages in a named environment

A named environment boots in two stages. `boot.sh` (stage 1) sets up the volume and Docker, walls
containers off from the host (`wall_off_containers`, before any container exists), pulls the worker
image by digest and then runs `run_stage2`: it reads `boot-stage2.sh` out of that image
(`docker create`, `docker cp <id>:/opt/agentx/boot/stage2.sh`, `docker rm`), checks its SHA-256
against `AGENTX_BOOT_STAGE2_SHA256`, sources it and calls `stage2_main`. Stage 2 writes the worker's
environment, launcher and unit, starts the worker, and starts the optional E2E qualification. A hash
mismatch fails the boot with a reason on `/ping`; the file is never sourced.

The hash is the launch setting `worker-boot-stage2-sha256`, written by the same runtime stack deploy
that writes `worker-image`, from the release source the image was built from (`release.json`'s
`bootStage2Sha256`; a hand-supplied `--worker-image` needs `--boot-stage2-sha256`). The legacy
(production) deployment keeps its single-file boot as `boot-legacy.sh`, byte for byte what `boot.sh`
was before the split (ruling R58).

## Failure reporting and volume discovery

Boot failures start a best-effort transient `/ping` responder outside cloud-init. It returns
`503` with `{"status":"BootFailed","reason":...}` so the provisioner can stop the session; if the
responder cannot start, the probe timeout still fails the session.

Nitro exposes EBS volumes as NVMe disks. The boot script identifies the requested volume by its
serial through `lsblk`, sysfs, or `/dev/disk/by-id`, and rescans PCI at 20, 50, and 80 seconds when
the kernel has not surfaced the disk. The elapsed counter includes sleeps so tests that stub sleep
retain the same retry thresholds.

The script formats only a blank volume created for the current generation. A blank volume expected
to contain an existing workspace indicates data loss or an incorrect attachment, so boot refuses to
format it. The workspace is recorded in `/etc/fstab`; systemd's `RequiresMountsFor=/mnt/workspace`
keeps the worker from starting against the root volume after a reboot without the EBS mount.

## Worker container

The root-owned worker launcher reconstructs the optional runtime bind each time systemd starts the
container. The backing directories live on the workspace EBS volume, and the unit orders startup
after that mount. An invalid or unavailable runtime path withholds verifier mounts while allowing
ordinary worker operations to use `/tmp`.

The worker shares the host network to serve port 8080 and reach instance credentials through IMDS
with hop limit 1. It receives the host Docker socket to run project devcontainers. The worker runs
as the `node` user in its container and has root-equivalent host access through the mounted Docker
socket. The workspace is mounted at the same host and container path so Docker bind mounts refer to
the same files. The worker removes other containers before a push, so the boot unit must remain the
only container that this script starts.

## Task sandbox

A project without a devcontainer runs a task's commands in a sandbox container that the worker
starts from its own image, so the worker's environment file carries two lines:
`AGENTX_SANDBOX_IMAGE` (the image the worker was launched from, which is already on the host) and
`AGENTX_RUNTIME=ec2`. The second makes the worker refuse to run a task's commands in its own
process, whatever else is set (the worker image also sets `AGENTX_WORKER_PROCESS_SCOPE=container`,
which the worker reads as the same mark). The sandbox mounts the workspace at the same path as the
worker does, which is why the worker's own mount keeps the host and container paths equal. The
sandbox has no Docker socket, no extra group, no capabilities and `no-new-privileges`, and joins a
user-defined bridge network (`agentx-task`) whose host interface is fixed to `rvbtask`
(`packages/worker/src/task-network.ts`). The boot firewall walls every `rvb*` bridge, so the sandbox
cannot reach private ranges, link-local addresses, the host's own ports (including the published
:8080) or the metadata address; only the VPC resolver's port 53 and the internet stay open. An
`agentx-task` network made by an earlier release (Docker's own `br-<hex>` name, which no rule
matches) is removed and made again. A project's devcontainer joins the same network: the worker
runs the devcontainer CLI with `--docker-path` set to `ec2/docker-walled.sh`, which adds
`--network agentx-task --cap-drop NET_RAW` to every `docker run` and `docker create`, and
`--network agentx-task` to every `docker build` (with the classic builder forced, because BuildKit cannot
put build containers on a named network; `buildx` is refused and the CLI is told `--buildkit never`), so
the Dockerfile's RUN steps and a feature's install scripts are walled too. The worker refuses a `network`
option in `runArgs` and `build.options`, removes a stopped devcontainer of an earlier release that is not
walled before `devcontainer up` can start it, and removes a started one that is attached to any other
network or kept NET_RAW. The network has inter-container traffic off (`enable_icc=false`): it is one
segment shared by every task's containers, and this keeps them from connecting to each other.
The default bridge (docker0) cannot be walled because the worker's own container is on it.

## Opt-in TS-L self-test (staging only)

A named environment's stage 2 can run Rovara's TS-L Linux checks (`scripts/linux-check-test-services.sh` and its live driver, the same ones the linux-runtime CI job runs) on the real worker and report the result in the worker's
`worker_start` line (key `selfTest`). The five release-gate conditions and the review's findings, in short (the long form is the comment above `TSL_SELFTEST_VARIABLE` in `boot-stage2.sh`):

- **Off by default, staging only.** It runs only when the launch environment carries `AGENTX_TSL_SELFTEST=1`, and then only in a named environment called exactly `staging`, on a worker image built with `CATALOG_FLAVOR=staging` (a
  release image carries no checks at all), in the staging account (the image's registry account and the instance identity document must both say it). Anything else records `refused` and runs nothing.
- **Never blocks the boot.** The whole self-test, clean-up included, ends before `BOOT_DEADLINE`: the checks get at most 170 s and only what is left after a 150 s reserve; with under 45 s it records `incomplete: no_time`.
- **Clean-up proven before work.** It applies the launcher's own wall steps first (`agentx-worker-start --walls-only`), so it runs against the firewall tasks get; after the checks every container, network, volume, bridge and rule it made
  is removed and read back (iptables and ip6tables in every table, nft, routes, ip rules and interfaces, compared in order), polled for about 15 s, with a second round before it gives up. If that fails the boot fails (`/ping` says
  `BootFailed`) and the provisioner stops the session. Because Docker's data root is on the workspace volume, EVERY named boot (self-test on or off) first removes anything carrying the two fixed labels
  (`rovara.tsl-selftest=1`, and the throwaway workspace key `rovara.run-network.workspace=7e57c4ec7e57c4ec`) and reads that back (`tsl_sweep_leftovers`).
- **Fixed output.** Item ids that are CI's, a status and a reason code each, the AMI id, the boot-stage2 SHA-256, the Docker version and the instance id; at most 3,000 characters. TS-RUN-3's Redis flush and http_reset have no CI id: they are
  `extra.redis-flush` and `extra.http-reset` in their own list, always pending. The result is written under `/run/agentx/tsl-selftest` and the launcher passes it only when it is there, so a rebooted instance reports nothing old.
- **Where the checks come from.** `packages/worker/ec2/tsl/checks.sh` and `live-driver.ts.txt` are byte-for-byte copies of the scripts under `scripts/` (held equal by `tests/contract/ec2-boot-tsl-selftest.test.ts`; the copies exist so the
  worker image's inputs and the release pipeline's trigger paths already cover them); the Dockerfile builds the driver to `live.mjs` in a staging build and removes the directory otherwise. The only pull is the pinned Postgres image, by digest,
  with the worker role's existing catalog grant.

### Recovery when the sweep or the read-back cannot clear leftovers (`tsl_leftover`)

Docker's data root is on the workspace volume, so a self-test object that cannot be removed would meet every later boot of that volume, and the boot FAILS CLOSED rather than let a customer task meet it. The session's failure then reads
`worker boot failed: tsl_leftover: ...` (the boot's `/ping` BootFailed reason), which tells it apart from any other boot failure. There is no automatic replacement of a claimed volume (the reconciler's quarantine only tags volumes
no session claims), so the recovery is the existing close path: close that workspace (its machine and volume are deleted) and start a new one; its volume is fresh. Nothing on a staging worker may be cleared by hand (no SSM, no key pair).
A person with a shell on a purpose-launched host can instead remove what carries the labels `rovara.tsl-selftest=1` and `rovara.run-network.workspace=7e57c4ec7e57c4ec` (containers, networks, volumes) and start again.

### How a staging launch turns it on (M1, an owner decision, 2026-11-12)

`AGENTX_TSL_SELFTEST` is a launch field, and only a staging launch whose operator switch is on carries it; everywhere else the self-test is off. The vendored (read-only) boot configuration is not touched:
`workerUserDataWithPrivateAddresses` (`packages/broker/src/aws/private-address-launch.ts`) appends `export AGENTX_TSL_SELFTEST='1'` after the rendered header, beside the private address exports (with or without a list; with neither
the user data is byte for byte what it was). It does so only when ALL hold:

- the launch is for a named environment;
- the install's worker settings prefix (`WORKER_SETTINGS_PREFIX`) is exactly `/agentx/staging/`;
- the operator's SSM parameter `<WORKER_SETTINGS_PREFIX>tsl-selftest` (`/agentx/staging/tsl-selftest`) holds exactly `true`. An absent parameter means off; `false`, any other value and a failed read all mean off (fail closed). The odd
  cases log the event `tsl_selftest.switch_unreadable` with the error's name or the word `value`, never the value.

`session-steps.ts` reads the parameter (`readTslSelftestOn`, beside `readPrivateAddressesOff`) at each named-environment launch, and only on the staging install: the dependency is wired nowhere else, so no other environment asks for it.
The steps function's role has one added statement for it, in `infra/lib/session-lifecycle.ts`, only when the environment is `staging`: `ssm:GetParameter` on exactly that one parameter. No other environment's template changes, and
workers get no IAM. Nothing creates the parameter: it is off until an operator creates it with the value `true` (and off again when it is deleted or set to anything else). Launches that already happened keep what they were given.

This is the switch only. The boot gate (`tsl_selftest_gate` in `boot-stage2.sh`) still refuses unless the environment name cut from the log group is `staging`, the worker image's build flavor is `staging`, and the registry account of the
worker image and the instance's own account are both the staging account; a launch that carries the variable anywhere else records `refused` and runs nothing.
