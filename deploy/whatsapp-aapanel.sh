#!/usr/bin/env bash
# Nama lama; diarahkan ke deploy/build.sh.
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/build.sh" "$@"
