#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/operations-common.sh"
operations_parse_arguments promote "$@"
source "$(dirname "${BASH_SOURCE[0]}")/operations-promotion-controller.sh"
source "$(dirname "${BASH_SOURCE[0]}")/operations-promotion-host.sh"
operations_main promote "$@"
