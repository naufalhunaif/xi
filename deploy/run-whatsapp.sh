#!/usr/bin/env bash
# Nama lama; diarahkan ke deploy/run.sh.
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/run.sh" "$@"
