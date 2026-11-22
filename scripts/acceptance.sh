#!/usr/bin/env bash
# Run from the checkout after npm ci and "node scripts/publish.mjs pack".
set -euo pipefail
: "${PAPPAI_REVISION:?Set PAPPAI_REVISION to the compatible controller commit}"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
git init -q "$tmp/controller"
git -C "$tmp/controller" fetch -q --depth=1 https://github.com/flinbein/pappai.git "$PAPPAI_REVISION"
git -C "$tmp/controller" checkout -q --detach FETCH_HEAD
docker build -t runner-codex-acceptance "$tmp/controller"
archive=$(npm pack --silent --pack-destination "$tmp" @openai/codex@0.170.0-linux-x64)
tar -xzf "$tmp/$archive" -C "$tmp"
npm install --prefix "$tmp/install" --no-audit --no-fund --ignore-scripts "$PWD/artifact/package.tgz"
sandbox=(--rm --init --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
native="$tmp/package/vendor/x86_64-unknown-linux-musl"
cli=(-v "$native:/native:ro" -e PAPPAI_TEST_CODEX_CLI=/native/bin/codex)
docker run "${sandbox[@]}" "${cli[@]}" -v "$PWD:/runner:ro" -w /runner runner-codex-acceptance \
  sh -ec 'mkdir -p /run/pappai/private && chmod 700 /run/pappai/private && node --test test/*.test.mjs'
docker run "${sandbox[@]}" "${cli[@]}" -v "$tmp/install/node_modules:/installed:ro" \
  -v "$tmp/controller/tests:/opt/pappai/tests:ro" \
  -e PAPPAI_TEST_CODEX_ENTRYPOINT=/installed/@flinbein/pappai-runner-codex/src/index.mjs \
  runner-codex-acceptance node --test tests/codex-package.test.ts
