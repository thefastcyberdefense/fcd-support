#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/operations-common.sh"
operations_parse_arguments abandon-empty-restore "$@"
source "$(dirname "${BASH_SOURCE[0]}")/operations-empty-restore.sh"
operations_main abandon-empty-restore "$@"
