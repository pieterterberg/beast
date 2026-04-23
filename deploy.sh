#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: ./deploy.sh <fly-app-name> [fly deploy args...]"
  exit 1
fi

app_name="$1"
shift

fly deploy --app "$app_name" "$@"
