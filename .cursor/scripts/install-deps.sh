#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

cd "$(dirname "$0")/../.."
bun install
