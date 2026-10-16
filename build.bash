#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# The release Dockerfile expects frontend-dist to exist in the build context.
docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env npm_config_cache=/tmp/npm-cache \
    --volume "$PWD:/app" --workdir /app \
    node:22-bookworm-slim \
    sh -c 'npm ci && npm run build:frontend'

docker build --file docker/Dockerfile --target release --tag dockge:latest .
