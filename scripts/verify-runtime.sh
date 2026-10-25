#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/operations-common.sh"
operations_parse_arguments verify "$@"
source "$(dirname "${BASH_SOURCE[0]}")/operations-controller.sh"
operations_main verify "$@"
