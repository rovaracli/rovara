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
