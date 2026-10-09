#!/usr/bin/env bash
# Entrypoint for the fakegithub container.
#
# Architecture: this container runs a rootful Podman daemon as an inner
# container runtime. OpenShift nodes use CRI-O as their outer runtime; CRI-O
# only speaks the Kubernetes CRI gRPC protocol and does not expose a
# Docker-compatible socket. func build --strategy=s2i requires one, so Podman
# runs inside the container to provide it.
#
# The pod must be privileged so the inner Podman can create namespaces and
# mount filesystems for the S2I builder containers it launches.
#
# --- Why this works on ROSA but not on CRC ---
#
# Pulling an S2I builder image (e.g., ubi8/nodejs-20-minimal) requires Podman
# to extract compressed tar layers into its overlay storage. containers/storage
# (go.podman.io/storage, vendored in Podman 5.8.2) handles this by spawning a
# subprocess with argv[0]="storage-untar" and expecting the child to handle it
# via a registered reexec handler (containers/storage/pkg/chrootarchive init).
#
# On ROSA and installer-provisioned clusters (RHCOS): the kernel supports idmapped mounts
# for overlay. containers/storage detects this at startup ("Cached value
# indicated that idmapped mounts for overlay are supported") and takes a
# completely different layer-extraction path that does NOT involve the reexec
# subprocess at all. Pulls succeed.
#
# On CRC (QEMU-backed VM): idmapped mounts for overlay are NOT supported
# ("Cached value indicated that idmapped mounts for overlay are not supported").
# containers/storage falls back to the reexec subprocess path. The child
# process runs the Podman binary with argv[0]="storage-untar", but Podman 5.8.2
# does not import go.podman.io/storage/pkg/chrootarchive in its main package,
# so the storage-untar handler is never registered. reexec.Init() returns false,
# cobra runs, sees "/" as an unknown command, and exits 125. The pull fails with:
#   "unpacking failed (error: exit status 125; output: Error: unrecognized
#    command 'podman /')"
#
# This is a bug in Podman 5.8.2 (UBI9 package). The fix would be to have
# Podman's main() import _ "go.podman.io/storage/pkg/chrootarchive" so the
# reexec handlers are registered. Until the upstream package is corrected,
# func build --strategy=s2i cannot pull images on CRC. The storage driver
# choice (overlay, fuse-overlayfs, vfs) does not matter; all drivers route
# through the same broken reexec path for layer extraction.
set -euo pipefail

PODMAN_SOCK="/run/podman/podman.sock"

# Mount a tmpfs at the Podman storage root. This gives Podman a clean,
# private backing filesystem for its overlay layers, preventing the pod's
# ephemeral storage from filling up and isolating each pod's image store.
mkdir -p /var/lib/containers/storage
mount -t tmpfs -o size=12g,mode=0755 tmpfs /var/lib/containers/storage

echo "=== fakegithub-entrypoint: starting Podman API service ===" >&2

mkdir -p "$(dirname "$PODMAN_SOCK")"
podman system service --time=0 "unix://${PODMAN_SOCK}" &

# Wait for the socket to appear (up to 10 s).
for i in $(seq 1 20); do
  [ -S "$PODMAN_SOCK" ] && break
  sleep 0.5
done
if [ ! -S "$PODMAN_SOCK" ]; then
  echo "fakegithub-entrypoint: podman system service did not start in time" >&2
  exit 1
fi

export DOCKER_HOST="unix://${PODMAN_SOCK}"
exec /usr/local/bin/fakegithub "$@"
