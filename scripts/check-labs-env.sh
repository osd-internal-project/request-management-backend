#!/usr/bin/env bash
# Preflight for the labs deploy: prove that THIS user can read the env file
# compose is about to hand to docker, before anything is pulled or removed.
#
# Why it exists. When `env_file:` cannot be resolved, compose prints
#
#   env file /etc/request-management/.frontend.env not found:
#   stat /etc/request-management/.frontend.env: no such file or directory
#
# for every one of the following, and they need opposite fixes:
#
#   - /etc/request-management was never created
#   - the file is genuinely absent
#   - the file is there but this user cannot read it — root-owned 600, or 640
#     with a group the runner is not in
#   - the parent directory has no x bit, so stat(2) cannot reach the file
#   - the path is a symlink to nothing
#
# "no such file or directory" names only the second one. A frontend deploy died
# on that message and a re-run passed, which is what a message that does not
# describe the failure looks like from the outside.
#
# Usage: bash scripts/check-labs-env.sh <path to the env file on the VM>
#
# No sudo, anywhere, on purpose. `sudo cat` proves root can read the file,
# which was never in doubt and is not the question. The question is whether the
# user that runs `docker compose` can read it, so this has to run as that user.
set -euo pipefail

ENV_FILE=${1:?usage: check-labs-env.sh <path to the env file on the VM>}
ENV_DIR=$(dirname "${ENV_FILE}")

# One short `::error::` headline, because that is what GitHub lifts to the top
# of the run summary and a paragraph there is unreadable. The detail and the
# fix follow as ordinary indented lines in the step log, where there is room.
fail() {
  local headline=$1
  shift
  echo "::error::${headline}"
  local line
  for line in "$@"; do
    echo "    ${line}"
  done
  exit 1
}

# stat's flags are not portable: -c is GNU (the VM), -f is BSD (a maintainer
# running this against a fixture on a mac). Try both, first one wins.
owner() {
  stat -c '%U %G %a' -- "$1" 2>/dev/null ||
    stat -f '%Su %Sg %OLp' -- "$1" 2>/dev/null ||
    echo 'unknown unknown unknown'
}

# Printed unconditionally and first. Every verdict below is relative to one
# identity, and a log that does not name it cannot be re-read six months later.
# That the runner is `github-runner` is asserted in prose in
# docs/labs-server-setup.md and has never been checked by anything that runs.
echo "user   : $(id -un) (uid $(id -u))"
echo "groups : $(id -Gn)"
echo "target : ${ENV_FILE}"

if [ ! -d "${ENV_DIR}" ]; then
  fail "${ENV_DIR} does not exist — this VM has not been provisioned" \
    "Fix: sudo install -d -m 755 ${ENV_DIR}" \
    "See docs/labs-server-setup.md §4."
fi

# A directory without its x bit hides its contents from stat(2): the file would
# report as missing while sitting there perfectly intact.
if [ ! -x "${ENV_DIR}" ]; then
  fail "${ENV_DIR} is not searchable by $(id -un)" \
    "owner/group/mode: $(owner "${ENV_DIR}")" \
    "stat(2) cannot reach the file through it, so compose calls the file missing." \
    "Fix: sudo chmod 755 ${ENV_DIR}"
fi

if [ -L "${ENV_FILE}" ] && [ ! -e "${ENV_FILE}" ]; then
  fail "${ENV_FILE} is a symlink whose target does not exist" \
    "The file is not missing — the link is dangling." \
    "Fix: point it at a real file, or replace it with one."
fi

if [ ! -e "${ENV_FILE}" ]; then
  fail "${ENV_FILE} does not exist" \
    "This one really is the missing-file case." \
    "Fix: scp .env.labs.example to the VM, fill it in there, then" \
    "     sudo install -m 640 -g $(id -gn) /tmp/<name>.env ${ENV_FILE}"
fi

if [ ! -f "${ENV_FILE}" ]; then
  fail "${ENV_FILE} is not a regular file" \
    "mode: $(owner "${ENV_FILE}")" \
    "compose needs a file here, not a directory or a device."
fi

# The readability verdict is an actual read, not `test -r`. `test -r` asks
# access(2) to model the mode bits; open(2) is the fact, and it is the same
# syscall compose makes — so ACLs, a read-only mount and LSM labels are all
# covered without being enumerated one by one.
#
# The model also lies in one direction that matters the moment a human debugs
# this by hand: root bypasses the mode bits, so `sudo test -r` — or running
# this script under plain sudo — answers "readable" for the exact mode-600 file
# that fails the deploy. Under the workflow it is moot, because this runs as
# the same user compose will; but the reproduction steps in the docs must never
# put a bare `sudo` in front of this. Use `sudo -u <runner> bash …` instead.
if ! CONTENT=$(cat -- "${ENV_FILE}" 2>/dev/null); then
  fail "${ENV_FILE} exists but $(id -un) cannot read it" \
    "owner/group/mode: $(owner "${ENV_FILE}")" \
    "this user's groups: $(id -Gn)" \
    "THIS is the case compose reports as 'no such file or directory'." \
    "Fix: sudo chgrp $(id -gn) ${ENV_FILE} && sudo chmod 640 ${ENV_FILE}"
fi

echo "mode   : $(owner "${ENV_FILE}") — read OK"

# Readable but empty is still a broken deploy, and a quiet one: compose starts
# every container with no configuration at all and they fail their healthchecks
# three minutes later without stating why.
if ! printf '%s\n' "${CONTENT}" |
  grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*='; then
  fail "${ENV_FILE} is readable but holds no KEY=value line" \
    "compose would start every container with no configuration at all."
fi

echo "✓ ${ENV_FILE} is readable by $(id -un)"
