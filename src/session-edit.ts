// Правки сессии терминала в своём пространстве и во flow (решение владельца: «с разрешения пользователя — что угодно»).
// Хук PreToolUse записи (Edit, Write, MultiEdit, NotebookEdit) решает по пути в момент вызова:
//   отказ    — папка команд Teamwork, папка тегов знаний, другое пространство или папка пространств вне пространства,
//              служебные файлы папки настроек agentgraph (settings.json, jira-token…);
//   вопрос   — своё пространство (выбранное сейчас, в том числе на ходу, и то, в папке которого сессия открыта) и папка
//              flow; space.json, карта, состояние и файл flow проверяются до вопроса по тексту, который получится после
//              записи (те же проверки, что у API), — не прошёл проверку — отказ с ошибками, человек его не видит;
//              вопрос — в default, acceptEdits, auto и bypassPermissions (у старого claude в bypassPermissions вопрос
//              заменяет отказом preToolDecision, sessions.ts: ASK_IN_ANY_MODE_SINCE); в dontAsk — отказ с причиной:
//              правило ask claude там превращает в отказ без вопроса;
//   пусто    — проект и всё прочее: решают правила --settings и режим, как раньше.
// Bash хук записи не видит: в bypassPermissions его команды сверяет bashDecision (эвристика по тексту команды).
// Хук PostToolUse проверяет проверенный файл ещё раз на диске (сломался — откат на снимок до записи) и говорит
// серверу, что обновить в UI. Чистая логика без HTTP: состояние сессии и события — sessions-server.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, isInside, toolPath, WRITE_TOOLS } from './artifacts.js';
import { nodeProbe } from './artifact-store.js';
import { configDir } from './settings.js';
import { tagsDir } from './tags.js';
import { teamsDir } from './teamwork.js';
import {
  checkSpaceCwd, checkSpaceDirs, checkSpaceMetaText, checkSpaceTextFile, cleanLine, DOCS_DIR, MAP_FILE, META_FILE, parseSpaceMeta, readSpaceMeta, spacesDir, SPACE_SLUG_RE,
  SPACE_TITLE_MAX, STATE_FILE, type SpaceMeta,
} from './spaces.js';
import { checkFlowText, plannedFlowFile } from './flows.js';
import { readRegular, writeAtomic } from './safe-fs.js';

/** Файл, который правят целиком в памяти для проверки: space.json — 1 МБ, карта — 20 000 знаков; flow больше не бывает. */
const EDIT_READ_MAX = 4 * 1024 * 1024;

/** Что сессия правит с вопросом и откуда считать пути. */
export type EditScope = {
  /** Рабочая папка сессии. */
  cwd: string;
  /** Рабочая папка claude в момент вызова (вход хука): от неё — относительные пути. */
  toolCwd?: string;
  /** Свои пространства (слаги): выбранное сейчас и то, в папке которого сессия открыта. */
  spaces: string[];
  /**
   * Пространства, папки которых открыты правилами запуска (launchDirs): папки остальных закрыты правилом deny ещё на
   * старте, и выбранное на ходу правится инструментами space_* или после «Перезапустить». Нет — не сверяется (тесты).
   */
  launched?: string[];
  /** Папка flow (FLOWS_DIR). */
  flowsDir: string;
};

/** Часть пространства: от неё — текст вопроса и проверка. */
export type SpacePart = 'map' | 'state' | 'meta' | 'doc' | 'claude' | 'other';

/**
 * Куда пишет вызов: пространство (слаг, часть) или папка flow (yaml — файл flow, его проверяет схема; inProject — папка
 * flow внутри проекта сессии: схема запущенного agentgraph может отстать от правок в нём самом — ошибка схемы тогда
 * предупреждение в вопросе, а не отказ, и после записи файл не откатывается).
 */
export type EditTarget = { kind: 'space'; slug: string; part: SpacePart; file: string } | { kind: 'flow'; file: string; root: string; yaml: boolean; inProject?: boolean };

export type EditDecision =
  | { decision: 'deny'; reason: string }
  /** before — текст файла до записи (null — файла не было): у проверенных файлов, для проверки и отката после записи. */
  | { decision: 'ask'; reason: string; target: EditTarget; before?: string | null };

const fold = (p: string) => p.normalize('NFC').toLowerCase();
const real = (p: string, base: string) => canonical(p, base, nodeProbe);
/** Корень root (по realpath), если путь p (уже канонический) внутри него без учёта регистра: APFS регистр не различает. */
const under = (p: string, root: string): string | undefined => {
  const r = real(root, '/');
  return isInside(fold(p), fold(r)) ? r : undefined;
};
/** Части пути p внутри root (under уже сверил их без учёта регистра): имена — как в p. */
const partsUnder = (p: string, root: string): string[] => p.slice(root.length).split(path.sep).filter(Boolean);

/** Куда пишет вызов и не закрыто ли это; undefined — не запись или путь не про agentgraph (решают правила и режим). */
export function classifyEdit(scope: EditScope, tool: string, input: Record<string, unknown>): { deny: string } | { target: EditTarget } | undefined {
  if (!WRITE_TOOLS.includes(tool)) return undefined;
  const raw = toolPath(tool, input);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const base = scope.toolCwd && path.isAbsolute(scope.toolCwd) ? scope.toolCwd : scope.cwd;
  const p = real(raw, base);
  if (under(p, teamsDir())) return { deny: `${raw} — в папке команд Teamwork: документы и задачи команды меняются через её экран в agentgraph, а правки агентов — через принятие черновика.` };
  // папка тегов знаний — не закрываем, только если сама сессия открыта в ней (это её проект), как в launchDirs
  if (under(p, tagsDir()) && !under(real(scope.cwd, '/'), tagsDir())) return { deny: `${raw} — в папке тегов знаний: теги правят на странице «Знания» в agentgraph.` };
  const spaces = under(p, spacesDir());
  if (spaces) {
    const [slug, ...rest] = partsUnder(p, spaces);
    const own = slug ? scope.spaces.find((s) => fold(s) === fold(slug)) : undefined;
    if (!own) {
      const mine = scope.spaces.length ? `только своё пространство (${scope.spaces.join(', ')})` : 'пространство, только когда оно выбрано у сессии';
      return { deny: `${raw} — ${slug && SPACE_SLUG_RE.test(slug.toLowerCase()) && rest.length ? `в другом пространстве (${slug})` : 'в папке пространств, но не в пространстве этой сессии'}: сессия правит ${mine}. Другие пространства правят на их страницах в agentgraph или в сессии с этим пространством.` };
    }
    if (scope.launched && !scope.launched.includes(own)) {
      return {
        deny:
          `Пространство ${own} выбрано на ходу: файлы его папки этому процессу claude закрыты правилами запуска. ` +
          'Карту, состояние, документы и настройки пиши инструментами space_map_write, space_state_write, space_write и space_settings — или попроси пользователя нажать «Перезапустить» в agentgraph.',
      };
    }
    return { target: { kind: 'space', slug: own, part: spacePart(rest), file: p } };
  }
  const flows = under(p, scope.flowsDir);
  // путь — от папки flow как её знает flows.ts: она может быть ссылкой, а имя и папку flow считают от неё
  if (flows) {
    const inProject = isInside(fold(flows), fold(real(scope.cwd, '/')));
    return { target: { kind: 'flow', file: path.join(scope.flowsDir, ...partsUnder(p, flows)), root: scope.flowsDir, yaml: /\.ya?ml$/i.test(p), ...(inProject ? { inProject } : {}) } };
  }
  // служебные файлы прямо в папке настроек agentgraph: settings.json, jira-token и подобные (папки внутри — не здесь);
  // папка настроек шире разумного (дом, корень) или сам проект сессии — не трогаем, как launchDirs
  const cfg = real(configDir(), '/');
  const broad = cfg === path.parse(cfg).root || fold(cfg) === fold(real(os.homedir(), '/')) || fold(real(scope.cwd, '/')) === fold(cfg);
  if (!broad && fold(path.dirname(p)) === fold(cfg)) return { deny: `${raw} — служебный файл agentgraph: настройки правят в agentgraph, на странице настроек.` };
  return undefined;
}

/** Текст команды для сверки путей: без кавычек и обратных слэшей, // и /./ схлопнуты, без учёта регистра. */
const commandText = (command: string): string => fold(command.replace(/["'\\]/g, '').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/'));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** За упоминанием пути — конец, «/», пробел или разделитель команды: папка feat не ловит feat-2 и flows — flows-old. */
const AFTER = '(?=$|[/\\s;&|)<>`])';
/** Перед относительным путём — начало, пробел, «=» или разделитель команды, можно с «./». */
const BEFORE_REL = '(?:^|[\\s=;&|(<>`])(?:\\./)?';

/** Как путь dir может быть написан в команде: как есть, realpath, ~/…, $HOME/…, ${HOME}/… и относительно cwd. */
function pathForms(dir: string, home: string, cwd: string): { abs: string[]; rel: string[] } {
  const abs = new Set([dir, real(dir, '/')]);
  const rel = new Set<string>();
  for (const f of [...abs]) {
    if (isInside(fold(f), fold(home)) && fold(f) !== fold(home)) for (const h of ['~', '$HOME', '${HOME}']) abs.add(h + f.slice(home.length));
    if (isInside(fold(f), fold(cwd)) && fold(f) !== fold(cwd)) rel.add(f.slice(cwd.length + 1));
  }
  return { abs: [...abs], rel: [...rel] };
}

const mentions = (text: string, forms: { abs: string[]; rel: string[] }): boolean =>
  forms.abs.some((f) => new RegExp(escapeRe(fold(f)) + AFTER).test(text)) || forms.rel.some((f) => new RegExp(BEFORE_REL + escapeRe(fold(f)) + AFTER).test(text));

/**
 * Bash в bypassPermissions: правило ask на своё пространство и папку flow держит Edit и Write, а файловую команду Bash
 * claude в этом режиме пускает молча (check-sdk-hooks, session-edit: cp в своё пространство записал файл без вопроса;
 * в default и acceptEdits он спрашивал сам, в dontAsk — отказывал). Эвристика по тексту команды (кавычки и «\» убраны,
 * // и /./ схлопнуты, без учёта регистра): команда упоминает папку своего пространства или папку flow — как есть,
 * realpath, ~/…, $HOME/…, относительно рабочей папки — либо идёт из рабочей папки внутри них — вопрос. Та же команда
 * упоминает и закрытое (чужое пространство, папку пространств целиком, теги, команды) — отказ: одобрение вопроса не
 * должно касаться закрытого, пусть модель разделит команду. Путь, собранный из переменных, эвристика не поймает — это
 * граница режима без вопросов; закрытое без своего и для Bash держит правило deny.
 */
export function bashDecision(scope: EditScope, command: string): { decision: 'ask' | 'deny'; reason: string } | undefined {
  const text = commandText(command);
  const home = real(os.homedir(), '/');
  const cwd = real(scope.toolCwd && path.isAbsolute(scope.toolCwd) ? scope.toolCwd : scope.cwd, '/');
  // как называть папку: «упоминает папку …» и «выполняется из папки …»
  const roots = [
    ...scope.spaces.map((slug) => ({ dir: path.join(spacesDir(), slug), acc: `папку пространства ${slug}`, gen: `папки пространства ${slug}` })),
    { dir: scope.flowsDir, acc: 'папку flow', gen: 'папки flow' },
  ];
  for (const r of roots) {
    const hit = mentions(text, pathForms(r.dir, home, cwd));
    if (!hit && !under(cwd, r.dir)) continue;
    const closed = closedMention(text, scope.spaces, home, cwd);
    if (closed) return { decision: 'deny', reason: `Команда Bash трогает и ${r.acc}, и ${closed}: одобрение правки своего не должно касаться закрытого — раздели команду, закрытое agentgraph не даст изменить` };
    return { decision: 'ask', reason: `Команда Bash ${hit ? `упоминает ${r.acc}` : `выполняется из ${r.gen}`} (${r.dir}): в режиме bypassPermissions claude пустил бы её без вопроса, а правки там — только с разрешения пользователя` };
  }
  return undefined;
}

/** Закрытое в тексте команды: чужое пространство или папка пространств целиком, папка тегов, папка команд. */
function closedMention(text: string, own: string[], home: string, cwd: string): string | undefined {
  if (mentions(text, pathForms(tagsDir(), home, cwd))) return 'папку тегов знаний';
  if (mentions(text, pathForms(teamsDir(), home, cwd))) return 'папку команд Teamwork';
  const mine = new Set(own.map(fold));
  const forms = pathForms(spacesDir(), home, cwd);
  for (const f of [...forms.abs.map((x) => ({ re: escapeRe(fold(x)) })), ...forms.rel.map((x) => ({ re: BEFORE_REL + escapeRe(fold(x)) }))]) {
    // за папкой пространств: «/слаг» — своё или чужое; ничего или разделитель — вся папка пространств
    for (const m of text.matchAll(new RegExp(f.re + '(?:/([^/\\s;&|)<>`]*))?' + AFTER, 'g'))) {
      const slug = m[1];
      if (!slug) return 'папку пространств целиком';
      if (!mine.has(slug)) return `пространство ${slug}`;
    }
  }
  return undefined;
}

function spacePart(rest: string[]): SpacePart {
  // без учёта регистра: на APFS claude.md — та же карта
  if (rest.length === 1 && fold(rest[0]) === fold(MAP_FILE)) return 'map';
  if (rest.length === 1 && fold(rest[0]) === fold(STATE_FILE)) return 'state';
  if (rest.length === 1 && fold(rest[0]) === META_FILE) return 'meta';
  if (rest[0] && fold(rest[0]) === '.claude') return 'claude';
  if (rest[0] === DOCS_DIR && rest.length > 1) return 'doc';
  return 'other';
}

/** Проверяется ли файл до и после записи: space.json, карта, состояние, файл flow. */
const checked = (t: EditTarget): boolean => (t.kind === 'space' ? t.part === 'meta' || t.part === 'map' || t.part === 'state' : t.yaml);

/**
 * Ответ хука PreToolUse на запись: отказ с причиной, вопрос с подробностями или undefined (решают правила и режим).
 * Проверенный файл (checked) проверяется по тексту после записи: не прошёл — отказ с ошибками, и вопроса нет.
 */
export function editDecision(scope: EditScope, tool: string, input: Record<string, unknown>): EditDecision | undefined {
  const c = classifyEdit(scope, tool, input);
  if (!c) return undefined;
  if ('deny' in c) return { decision: 'deny', reason: c.deny };
  const t = c.target;
  const raw = String(toolPath(tool, input));
  if (!checked(t)) return { decision: 'ask', reason: askText(t), target: t };
  const before = readText(t.file) ?? null;
  let after: string;
  try {
    after = textAfter(tool, input, before ?? undefined);
  } catch (err) {
    // посчитать, как Claude Code, не вышло (кавычки-«ёлочки», CRLF, устаревший old_string): Claude Code может применить
    // правку по-своему или сам откажет — спрашиваем, а проверит запись хук после неё (откат на снимок)
    return { decision: 'ask', reason: `${askText(t)}. Проверить заранее не вышло (${errText(err)}): agentgraph проверит файл после записи и вернёт прежний, если он сломан`, target: t, before };
  }
  try {
    return { decision: 'ask', reason: `${askText(t)}. ${validate(t, after, before)}`, target: t, before };
  } catch (err) {
    // flow внутри проекта сессии: схема запущенного agentgraph может отстать от правок в самом проекте — решает человек
    if (t.kind === 'flow' && t.inProject) return { decision: 'ask', reason: `${askText(t)}. ⚠ Запущенный agentgraph эту версию не примет: ${errText(err)}`, target: t, before };
    return { decision: 'deny', reason: `${raw}: ${errText(err)}. Файл не записан — исправь и повтори.` };
  }
}

/**
 * Проверка файла после записи (хук PostToolUse): прошёл — undefined; не прошёл — файл возвращается к снимку до записи
 * (before; null — файла не было, он удаляется) и ответ — что сказать модели. Без снимка — только сказать.
 */
export function recheckEdit(t: EditTarget, before?: string | null): string | undefined {
  if (!checked(t)) return undefined;
  const text = readText(t.file);
  try {
    validate(t, text ?? '', before);
    return undefined;
  } catch (err) {
    // flow внутри проекта сессии человек записал, зная о предупреждении: не откатываем
    if (t.kind === 'flow' && t.inProject) return `${t.file}: запущенный agentgraph эту версию flow не примет (${errText(err)}) — до перезапуска сервера с новой схемой flow в списке будет с ошибкой.`;
    let undo = '';
    try {
      if (before === null) {
        fs.rmSync(t.file, { force: true });
        undo = ' Файл удалён: до записи его не было.';
        // папка flow, опустевшая после отката (её завела эта запись), — тоже: иначе она висела бы в списке flow
        const dir = path.dirname(t.file);
        if (t.kind === 'flow' && dir !== t.root && !fs.readdirSync(dir).length) {
          fs.rmdirSync(dir);
          undo += ' Опустевшая папка flow удалена.';
        }
      } else if (before !== undefined) {
        writeAtomic(t.file, before);
        undo = ' Возвращена версия до записи.';
      }
    } catch (e) {
      undo = ` Вернуть прежнюю версию не вышло (${errText(e)}).`;
    }
    return `${t.file} после записи не проходит проверку agentgraph: ${errText(err)}.${undo} Исправь и повтори.`;
  }
}

/** Что вопрос говорит о запусках: начатый идёт по своему снимку, остальное возьмёт новую версию. */
export const FLOW_RUNS_NOTE = 'Начатый запуск идёт по своему снимку; новый запуск, продолжение и вызов из другого flow возьмут эту версию';

/**
 * Проверка текста файла; ответ — подробность к вопросу (что изменится). before — текст до записи (null — файла не
 * было; undefined — неизвестен): от него space.json сверяет неизменяемые поля и что поменялось.
 */
function validate(t: EditTarget, text: string, before?: string | null): string {
  if (t.kind === 'flow') {
    const f = checkFlowText(t.file, text);
    return `${f.exists ? 'Изменит flow' : 'Новый flow'} ${f.name}${f.folder ? ` (папка ${f.folder})` : ''}, схема в порядке. ${FLOW_RUNS_NOTE}`;
  }
  if (t.part === 'meta') {
    const prev = metaBefore(t.slug, before);
    return metaDiff(prev ?? undefined, checkSpaceMetaText(t.slug, text, prev));
  }
  checkSpaceTextFile(t.part === 'map' ? MAP_FILE : STATE_FILE, text);
  return `${text.length} знаков`;
}

/** space.json до записи: undefined — неизвестен (сверять не с чем), null — его не было или он сломан. */
function metaBefore(slug: string, before: string | null | undefined): SpaceMeta | null | undefined {
  if (before === undefined || before === null) return before;
  try {
    return parseSpaceMeta(slug, before);
  } catch {
    return null; // сломанный space.json правка чинит
  }
}

/**
 * Пространство, в папке которого открыта сессия (cwd в spaces/<слаг>/…): его она правит как свой проект, с вопросом.
 * Сверка по realpath: ~/.agentgraph бывает ссылкой.
 */
export function cwdSpace(cwd: string): string | undefined {
  const root = real(spacesDir(), '/');
  const p = real(cwd, '/');
  if (!isInside(fold(p), fold(root))) return undefined;
  const slug = partsUnder(p, root)[0];
  return slug && SPACE_SLUG_RE.test(slug) ? slug : undefined;
}

/** Подробность вопроса flow_write: куда ляжет и что будет; не пройдёт проверку (имя, папка, схема, вызовы) — ошибка. */
export function flowWriteDetail(args: { name: string; yaml: string; folder?: string }): string {
  return validate({ kind: 'flow', file: plannedFlowFile(args.name, args.folder), root: '', yaml: true }, args.yaml);
}

/** Подробность вопроса space_settings: что изменится; не пройдёт проверку API (папки, рабочая папка) — ошибка. */
export function spaceSettingsDetail(slug: string, args: { title?: string; dirs?: string[]; cwd?: string | null }): string {
  const prev = readSpaceMeta(slug);
  if (!prev) throw new Error(`Пространства ${slug} нет`);
  const dirs = args.dirs !== undefined ? checkSpaceDirs(args.dirs) : prev.dirs;
  const cwd = args.cwd !== undefined ? checkSpaceCwd(args.cwd) : prev.cwd;
  const title = args.title !== undefined ? cleanLine(args.title, SPACE_TITLE_MAX) : prev.title;
  return metaDiff(prev, { ...prev, ...(title ? { title } : { title: undefined }), dirs, cwd });
}

/** Что изменит правка space.json: заголовок, папки чтения (их откроют все сессии и запуски), рабочая папка, теги знаний. */
function metaDiff(prev: SpaceMeta | undefined, next: SpaceMeta): string {
  const out: string[] = [];
  if ((prev?.title ?? '') !== (next.title ?? '')) out.push(`заголовок → «${next.title ?? ''}»`);
  const was = new Set(prev?.dirs ?? []);
  const now = new Set(next.dirs ?? []);
  const added = [...now].filter((d) => !was.has(d));
  const removed = [...was].filter((d) => !now.has(d));
  if (added.length) out.push(`откроет на чтение всем сессиям и запускам пространства: ${added.join(', ')}`);
  if (removed.length) out.push(`уберёт из папок чтения: ${removed.join(', ')}`);
  if ((prev?.cwd ?? '') !== (next.cwd ?? '')) out.push(`рабочая папка → ${next.cwd ?? 'нет'}`);
  // теги знаний пространства формы подставляют в каждую его сессию и запуск
  const tagsWas = prev?.tags ?? [];
  const tagsNow = next.tags ?? [];
  const tagsAdded = tagsNow.filter((x) => !tagsWas.includes(x));
  const tagsRemoved = tagsWas.filter((x) => !tagsNow.includes(x));
  if (tagsAdded.length) out.push(`добавит теги знаний, которые получат сессии и запуски пространства: ${tagsAdded.join(', ')}`);
  if (tagsRemoved.length) out.push(`снимет теги знаний: ${tagsRemoved.join(', ')}`);
  return out.length ? `${out.join('; ')}` : 'Заголовок, папки, рабочая папка и теги знаний не меняются';
}

function askText(t: EditTarget): string {
  if (t.kind === 'flow') return `agentgraph: ${t.yaml ? 'flow' : 'файл в папке flow'} ${t.file}`;
  const head = `agentgraph: пространство ${t.slug} —`;
  switch (t.part) {
    case 'map':
      return `${head} карта (${MAP_FILE}): её получат памятью все следующие сессии и запуски пространства. ${t.file}`;
    case 'state':
      return `${head} состояние (${STATE_FILE}) «где мы сейчас» для следующих сессий и запусков. ${t.file}`;
    case 'meta':
      return `${head} настройки (${META_FILE}). ${t.file}`;
    case 'doc':
      return `${head} документ: его увидят следующие сессии и запуски пространства. ${t.file}`;
    case 'claude':
      return `${head} .claude/: настройки, скиллы и команды грузятся во все его сессии. ${t.file}`;
    default:
      return `${head} файл в папке пространства. ${t.file}`;
  }
}

/** Текст файла (обычного, не больше EDIT_READ_MAX); нет файла — undefined; FIFO, папка или огромный — ошибка. */
function readText(file: string): string | undefined {
  return readRegular(file, { max: EDIT_READ_MAX });
}

/**
 * Текст файла после вызова — как его посчитает Claude Code: Write — content; Edit и MultiEdit — замены old_string на
 * new_string по очереди (old_string встречается ровно раз или replace_all; пустой — только у нового или пустого файла).
 * NotebookEdit правит только ноутбуки. Не сходится — ошибка: Claude Code тоже не применил бы правку.
 */
export function textAfter(tool: string, input: Record<string, unknown>, before: string | undefined): string {
  if (tool === 'Write') {
    if (typeof input.content !== 'string') throw new Error('content — строка');
    return input.content;
  }
  if (tool === 'Edit') return applyEdits(before, [input]);
  if (tool === 'MultiEdit') {
    if (!Array.isArray(input.edits)) throw new Error('edits — список');
    return applyEdits(before, input.edits as Record<string, unknown>[]);
  }
  throw new Error(`${tool} правит только ноутбуки .ipynb`);
}

function applyEdits(text: string | undefined, edits: Record<string, unknown>[]): string {
  let t = text;
  for (const e of edits) {
    const old = e?.old_string;
    const neu = e?.new_string;
    if (typeof old !== 'string' || typeof neu !== 'string') throw new Error('old_string и new_string — строки');
    if (old === '') {
      if (t) throw new Error('пустой old_string — только у нового или пустого файла');
      t = neu;
      continue;
    }
    if (t === undefined) throw new Error('файла ещё нет');
    const at = t.indexOf(old);
    if (at < 0) throw new Error('old_string не найден в файле');
    if (e.replace_all === true) t = t.split(old).join(neu);
    else if (t.indexOf(old, at + 1) >= 0) throw new Error('old_string встречается больше одного раза');
    else t = t.slice(0, at) + neu + t.slice(at + old.length);
  }
  return t ?? '';
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
