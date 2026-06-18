#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Запуск юнит-тестов под gjs. Каждый *.test.js в этом каталоге исполняется как
# ESM-модуль; ненулевой код возврата любого файла делает весь прогон упавшим.

set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v gjs >/dev/null 2>&1; then
  echo "gjs не найден в PATH; установите gjs для запуска тестов" >&2
  exit 127
fi

status=0
for t in "$dir"/*.test.js; do
  echo "=== ${t##*/} ==="
  if ! gjs -m "$t"; then
    status=1
  fi
  echo
done

exit "$status"
