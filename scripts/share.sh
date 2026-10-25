#!/usr/bin/env bash
# Упаковывает agentgraph, чтобы поделиться с командой: только исходники, UI, примеры флоу и документация.
# Не попадают: личные флоу (всё в flows/, кроме flows/example/), запуски (runs/), node_modules, dist,
# локальные настройки .claude/settings*.json и посторонние скиллы (в архив идут только .claude/skills/agentgraph и .claude/skills/session-to-flow).
# Этот же набор (функция keep) — единственное, что уходит в git remote: личное туда не пушится.
#
#   npm run share                     -> release/agentgraph-<версия>-<дата>.zip
#   npm run share -- --out ~/Desktop  -> положить архив в другую папку
#   npm run share -- --no-examples    -> без flows/example/
#   npm run share -- --push           -> общий набор из закоммиченного main одним коммитом поверх main в origin
#                                        (--ref <ветка> и --remote <имя> — другая ветка или remote);
#                                        версия в package.json новее, чем в origin, — ещё и тег v<версия>.
#                                        Отказывает, если в origin/main влиты (MR) изменения, которых нет в main:
#                                        снимок их откатил бы; --overwrite-remote — затереть осознанно
#   scripts/share.sh --pre-push <remote> -> проверка для .git/hooks/pre-push: отклоняет коммиты с личными файлами
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/release"
EXAMPLES=1
MODE=zip
REF=main
REMOTE=origin
OVERWRITE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --no-examples) EXAMPLES=0; shift ;;
    --push) MODE=push; shift ;;
    --ref) REF="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --overwrite-remote) OVERWRITE=1; shift ;;
    --pre-push) MODE=pre-push; REMOTE="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Пути коммита, которых нет в общем наборе.
private_paths() {
  git ls-tree -r -z --name-only "$1" | while IFS= read -r -d '' f; do keep "$f" || printf '%s\n' "$f"; done
}

if [ "$MODE" = pre-push ]; then
  # git подаёт на stdin строки «<local ref> <local sha> <remote ref> <remote sha>»; проверяем каждый новый для remote коммит
  while read -r _ lsha _ _; do
    [[ "$lsha" =~ ^0+$ ]] && continue                # удаление ветки
    for c in $(git rev-list "$lsha" --not --remotes="$REMOTE"); do
      bad="$(private_paths "$c")"
      [ -z "$bad" ] && continue
      echo "pre-push: в $REMOTE уходит только общее, а в коммите $(git rev-parse --short "$c") есть личные файлы:" >&2
      printf '%s\n' "$bad" | sed -n '1,10s/^/  /p' >&2
      fail "Публикуй через npm run share -- --push (scripts/share.sh)"
    done
  done
  exit 0
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [ "$MODE" = push ]; then
  # Публикуем закоммиченное, а не рабочее дерево: в main checkout бывают незаконченные правки других сессий.
  git rev-parse -q --verify "$REF^{commit}" >/dev/null || fail "Нет ветки $REF"
  SRC="$(git rev-parse --short "$REF")"
  VERSION="$(git show "$REF:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")"

  PARENT=""
  rc=0; git ls-remote --exit-code "$REMOTE" refs/heads/main >/dev/null || rc=$?
  case "$rc" in
    0) git fetch -q "$REMOTE" refs/heads/main; PARENT="$(git rev-parse FETCH_HEAD)" ;;
    2) ;;                                            # пустой репозиторий: первый коммит без родителя
    *) fail "Не достучаться до $REMOTE" ;;
  esac

  # Дерево собираем во временном индексе: рабочее дерево и настоящий индекс не трогаем.
  export GIT_INDEX_FILE="$STAGE/index"
  git read-tree "$REF"
  git ls-files -z | while IFS= read -r -d '' f; do keep "$f" || printf '%s\0' "$f"; done \
    | git update-index -z --force-remove --stdin
  EMPTY="$(git hash-object -w --stdin </dev/null)"
  git update-index --add --cacheinfo "100644,$EMPTY,runs/.gitkeep"
  [ -n "$(git ls-files -- flows)" ] || git update-index --add --cacheinfo "100644,$EMPTY,flows/.gitkeep"
  TREE="$(git write-tree)"
  count="$(git ls-files | wc -l | tr -d ' ')"

  # MR вливаются прямо в origin/main, мимо main: их изменения после последнего снимка должны уже быть в $REF,
  # иначе новый снимок молча их откатит. Проверка — изменения с последнего снимка откатываются с набора $REF.
  if [ -n "$PARENT" ] && [ "$OVERWRITE" = 0 ]; then
    SNAP="$(git log -1 --first-parent --format=%H -E --grep='^agentgraph [0-9]' "$PARENT")"
    if [ -n "$SNAP" ] && [ "$SNAP" != "$PARENT" ]; then
      git diff --binary "$SNAP" "$PARENT" >"$STAGE/remote.diff"
      if [ -s "$STAGE/remote.diff" ] && ! git apply --cached --check -R "$STAGE/remote.diff" 2>/dev/null; then
        unset GIT_INDEX_FILE
        echo "В $REMOTE/main после снимка $(git rev-parse --short "$SNAP") влиты изменения, которых нет в $REF — публикация их откатит:" >&2
        git log --oneline --no-merges "$SNAP..$PARENT" | sed 's/^/  /' >&2
        fail "Перенеси их в $REF (git cherry-pick -x <sha>) и повтори. Затереть осознанно: --overwrite-remote"
      fi
    fi
  fi
  unset GIT_INDEX_FILE

  if [ -n "$PARENT" ] && [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ]; then
    echo "Нечего публиковать: общий набор $REF ($SRC) уже совпадает с $REMOTE/main"
    exit 0
  fi
  COMMIT="$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "agentgraph $VERSION ($REF $SRC, $(date +%Y-%m-%d))")"

  # Версия поднята (npm run release) — аннотированный тег v<версия> на коммит публикации, в том же атомарном push.
  # По тегу CI заводит релиз в GitLab с разделом из CHANGELOG.md (.gitlab-ci.yml, джоба release).
  TAG="" TAGSPEC=""
  if [ -n "$PARENT" ] && [ "$(git show "$PARENT:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")" != "$VERSION" ]; then
    TAG="v$VERSION"
    [ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ] || fail "Тег $TAG уже есть в $REMOTE: подними версию (npm run release)"
    TAGOBJ="$(printf 'object %s\ntype commit\ntag %s\ntagger %s\n\nagentgraph %s\n' \
      "$COMMIT" "$TAG" "$(git var GIT_COMMITTER_IDENT)" "$VERSION" | git mktag)"
    TAGSPEC="$TAGOBJ:refs/tags/$TAG"
  fi
  git push -q --atomic "$REMOTE" "$COMMIT:refs/heads/main" ${TAGSPEC:+"$TAGSPEC"}
  echo "Опубликовано: $REMOTE main ← $(git rev-parse --short "$COMMIT")${TAG:+, тег $TAG} (общий набор из $REF $SRC, файлов: $count)"
  exit 0
fi

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
