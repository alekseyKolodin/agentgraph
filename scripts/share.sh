#!/usr/bin/env bash
# Упаковывает agentgraph в архив, чтобы передать без git: только исходники, UI, примеры флоу и документация.
# Не попадают: личные флоу (всё в flows/, кроме flows/example/), запуски (runs/), node_modules, dist,
# локальные настройки .claude/settings*.json и посторонние скиллы (в архив идут только .claude/skills/agentgraph и .claude/skills/session-to-flow).
#
#   npm run share                     -> release/agentgraph-<версия>-<дата>.zip
#   npm run share -- --out ~/Desktop  -> положить архив в другую папку
#   npm run share -- --no-examples    -> без flows/example/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/release"
EXAMPLES=1

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --no-examples) EXAMPLES=0; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "$*" >&2; exit 1; }

cd "$ROOT"

# Список файлов: из git (отслеживаемые + новые, с учётом .gitignore), без git — обходом дерева.
list_files() {
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT" ls-files --cached --others --exclude-standard
  else
    find . -type f \
      -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' \
      -not -path './runs/*' -not -path './release/*' -not -name '.DS_Store' | sed 's|^\./||'
  fi
}

keep() {
  case "$1" in
    flows/example/*) [ "$EXAMPLES" = 1 ] ;;
    flows/.gitkeep|runs/.gitkeep) return 0 ;;
    flows/*|runs/*|release/*|node_modules/*|dist/*) return 1 ;;
    .claude/skills/agentgraph/*|.claude/skills/session-to-flow/*|.claude/launch.json) return 0 ;;
    .claude/*) return 1 ;;
    *.zip|.DS_Store|*/.DS_Store|.env|.env.*) return 1 ;;
    *) return 0 ;;
  esac
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

command -v zip >/dev/null || fail "Нужна утилита zip"

VERSION="$(node -p "require('./package.json').version")"
NAME="agentgraph-$VERSION-$(date +%Y-%m-%d)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
ARCHIVE="$OUT_DIR/$NAME.zip"

DEST="$STAGE/agentgraph"
mkdir -p "$DEST"

count=0
while IFS= read -r f; do
  [ -f "$f" ] || continue          # удалённые, но ещё отслеживаемые файлы
  keep "$f" || continue
  mkdir -p "$DEST/$(dirname "$f")"
  cp -p "$f" "$DEST/$f"
  count=$((count + 1))
done < <(list_files)

# пустые каталоги, чтобы структура была видна сразу; код и сам создаёт их при первой записи
mkdir -p "$DEST/flows" "$DEST/runs"
[ -n "$(ls -A "$DEST/flows")" ] || touch "$DEST/flows/.gitkeep"
touch "$DEST/runs/.gitkeep"

rm -f "$ARCHIVE"
(cd "$STAGE" && zip -qr -X "$ARCHIVE" agentgraph)

echo "Готово: $ARCHIVE"
echo "Файлов: $count, размер: $(du -h "$ARCHIVE" | cut -f1)"
echo "Дальше у получателя: распаковать, npm install, npm run ui (подробно — docs/GETTING_STARTED.md)"
