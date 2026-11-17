// Проверка команды, которую придумала модель при подключении словами. Её запускают на машине пользователя сразу, до того
// как он увидит запрос, а текст сервисов в сессии — недоверенные данные. Поэтому принимаем только один curl на https
// (по желанию с `| jq …`), без записи в файлы, чтения локальных файлов, подстановок команд и чужих переменных окружения.

type Token = string;

// Белые списки: всё, чего нет в списках, — запрещено (запись/чтение файлов, прокси, конфиги, шаблоны с файлами).
const CURL_SHORT_BOOL = new Set('sSfLGgIi46');
const CURL_SHORT_VALUE = new Set('AdHXuem');
const CURL_LONG_BOOL = new Set(['silent', 'show-error', 'fail', 'fail-with-body', 'location', 'get', 'globoff', 'compressed', 'http1.1', 'http2', 'head', 'include', 'ipv4', 'ipv6', 'no-progress-meter']);
const CURL_LONG_VALUE = new Set(['header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'url-query', 'request', 'user', 'user-agent', 'referer', 'max-time', 'connect-timeout', 'retry', 'url']);
/** Флаги, значение которых curl может прочитать из файла через «@»; к ним относится и заголовок (`-H @file`). */
const CURL_AT_FLAGS = new Set(['d', 'H', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'url-query', 'header']);
const SHORT_NAME: Record<string, string> = { A: 'user-agent', X: 'request', u: 'user', e: 'referer', m: 'max-time' };
const JQ_BAD = /\b(env|include|import|input_filename|\$ENV|\$__prog_args|getpath|debug|stderr|input|inputs)\b|\$ENV/;
const JQ_SHORT_BOOL = new Set('rcesnRSMjaC');
const JQ_LONG_BOOL = new Set(['raw-output', 'compact-output', 'exit-status', 'slurp', 'null-input', 'raw-input', 'sort-keys', 'monochrome-output', 'join-output', 'ascii-output', 'tab']);
const JQ_LONG_VALUE: Record<string, number> = { arg: 2, argjson: 2, indent: 1 };

/** Разбор строки шелла на слова по конвейеру. Подстановки команд, перенаправления, `;`, `&`, комментарии — ошибка. */
export function splitShell(cmd: string, allowedVars: ReadonlySet<string>): Token[][] {
  const segments: Token[][] = [[]];
  let word = '';
  let inWord = false;
  const seg = (): Token[] => segments[segments.length - 1];
  const endWord = (): void => {
    if (inWord) seg().push(word);
    word = '';
    inWord = false;
  };
  const variable = (i: number): number => {
    // cmd[i] === '$': читаем $NAME или ${NAME}
    const rest = cmd.slice(i + 1);
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}|^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (!m) throw new Error('подстановки ($(…), $?, $1) запрещены');
    const name = m[1] ?? m[2];
    if (!allowedVars.has(name)) throw new Error(`переменная $${name} не входит в список ключей источника`);
    word += '‹var›';
    inWord = true;
    return i + m[0].length;
  };
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error('незакрытая кавычка');
      word += cmd.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      inWord = true;
      i++;
      for (;;) {
        if (i >= cmd.length) throw new Error('незакрытая кавычка');
        const c = cmd[i];
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\\' && i + 1 < cmd.length) {
          const n = cmd[i + 1];
          if (n === '\n') i += 2;
          else if ('"\\$`'.includes(n)) {
            word += n;
            i += 2;
          } else {
            word += c;
            i++;
          }
        } else if (c === '`') throw new Error('обратные кавычки запрещены');
        else if (c === '$') i = variable(i);
        else {
          word += c;
          i++;
        }
      }
    } else if (ch === '\\') {
      if (cmd[i + 1] === '\n') i += 2;
      else {
        word += cmd[i + 1] ?? '';
        inWord = true;
        i += 2;
      }
    } else if (ch === '$') i = variable(i);
    else if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
    } else if (ch === '\n') throw new Error('несколько команд в строках запрещены');
    else if (ch === '|') {
      if (cmd[i + 1] === '|') throw new Error('«||» запрещено');
      endWord();
      segments.push([]);
      i++;
    } else if (';&<>`(){}'.includes(ch) && ch !== '{' && ch !== '}') throw new Error(`символ «${ch}» запрещён`);
    else if (ch === '#' && !inWord) throw new Error('комментарии запрещены');
    else {
      word += ch;
      inWord = true;
      i++;
    }
  }
  endWord();
  return segments;
}

/** undefined — команда подходит; строка — почему нет. */
export function commandProblem(cmd: string, secrets: readonly string[]): string | undefined {
  let segments: Token[][];
  try {
    segments = splitShell(cmd.trim(), new Set(secrets));
  } catch (err) {
    return `Команда не прошла проверку: ${(err as Error).message}`;
  }
  if (segments.some((s) => !s.length)) return 'Команда не прошла проверку: пустая часть конвейера';
  if (segments.length > 2) return 'Команда не прошла проверку: допустим один curl и необязательный jq';
  const [curl, jq] = segments;
  if (curl[0] !== 'curl') return 'Команда не прошла проверку: должна начинаться с curl';
  const problem = curlProblem(curl) ?? (jq ? jqProblem(jq) : undefined);
  return problem ? `Команда не прошла проверку: ${problem}` : undefined;
}

function curlProblem(curl: Token[]): string | undefined {
  let hasUrl = false;
  const value = (flag: string, v: string): string | undefined => {
    if (CURL_AT_FLAGS.has(flag) && v.includes('@')) return 'чтение файла через @ запрещено (символ @ в данных и заголовках)';
    if ((flag === 'X' || flag === 'request') && !/^(GET|POST)$/i.test(v)) return 'разрешены только GET и POST';
    if (flag === 'url') {
      if (!/^https?:\/\//i.test(v)) return 'адрес должен начинаться с https://';
      hasUrl = true;
    }
    return undefined;
  };
  for (let i = 1; i < curl.length; i++) {
    const w = curl[i];
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = (eq === -1 ? w : w.slice(0, eq)).slice(2);
      if (CURL_LONG_BOOL.has(name) && eq === -1) continue;
      if (!CURL_LONG_VALUE.has(name)) return `флаг ${w.slice(0, eq === -1 ? undefined : eq)} запрещён`;
      const v = eq === -1 ? curl[++i] : w.slice(eq + 1);
      if (v === undefined) return `у флага --${name} нет значения`;
      const p = value(name, v);
      if (p) return p;
    } else if (w.startsWith('-') && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        const c = w[k];
        if (CURL_SHORT_BOOL.has(c)) continue;
        if (!CURL_SHORT_VALUE.has(c)) return w.length === 2 ? `флаг ${w} запрещён` : `флаг ${w} содержит запрещённую опцию -${c}`;
        const rest = w.slice(k + 1);
        const v = rest || curl[++i];
        if (v === undefined) return `у флага -${c} нет значения`;
        const p = value(SHORT_NAME[c] ?? c, v);
        if (p) return p;
        break;
      }
    } else {
      // позиционный аргумент curl — адрес
      if (!/^https?:\/\//i.test(w)) return /^[a-z][a-z0-9+.-]*:/i.test(w) ? `адрес ${w.split(':')[0]}:// запрещён` : `«${w}» не похоже на адрес https://`;
      hasUrl = true;
    }
  }
  return hasUrl ? undefined : 'не нашёл адрес https://';
}

function jqProblem(jq: Token[]): string | undefined {
  if (jq[0] !== 'jq') return 'после «|» допустим только jq';
  let filter: string | undefined;
  for (let i = 1; i < jq.length; i++) {
    const w = jq[i];
    if (w.startsWith('--')) {
      const name = w.slice(2);
      if (JQ_LONG_BOOL.has(name)) continue;
      const n = JQ_LONG_VALUE[name];
      if (!n) return `флаг jq ${w} запрещён`;
      if (jq.length - 1 - i < n) return `у флага jq ${w} нет значения`;
      i += n;
    } else if (w.startsWith('-') && w.length > 1) {
      for (const c of w.slice(1)) if (!JQ_SHORT_BOOL.has(c)) return `флаг jq ${w} запрещён`;
    } else if (filter === undefined) {
      filter = w;
      if (JQ_BAD.test(w)) return 'в фильтре jq запрещены env, include, import, input';
    } else return 'jq принимает только фильтр: аргументы-файлы запрещены';
  }
  return undefined;
}
