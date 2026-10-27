// Тексты раннера в отчёте запуска (detail и feedback условий) — на язык интерфейса: раннер пишет их по-русски,
// а сервер не переводит. Незнакомый текст (вердикт судьи, вывод команды) остаётся как есть.
import { t } from '../i18n';

const CMD = /^Команда `([\s\S]*?)` завершилась с кодом (\S+)\. Вывод \(хвост\):\n/;

/** type — тип условия: известен — проверяются только тексты раннера этого типа, чтобы не задеть вердикт судьи. */
export function runnerText(s: string | undefined, type?: string): string {
  if (!s) return '';
  const is = (k: string) => !type || type === k;
  if (is('marker')) {
    const m = /^маркер (.+) последней строкой вывода (.+): (есть|нет)$/.exec(s);
    if (m) return m[3] === 'есть'
      ? t('маркер {marker} последней строкой вывода {phase}: есть', { marker: m[1]!, phase: m[2]! })
      : t('маркер {marker} последней строкой вывода {phase}: нет', { marker: m[1]!, phase: m[2]! });
  }
  if (is('command')) {
    const m = CMD.exec(s);
    if (m) return t('Команда `{run}` завершилась с кодом {code}. Вывод (хвост):', { run: m[1]!, code: m[2]! }) + '\n' + s.slice(m[0].length);
  }
  if (is('judge')) {
    const m = /^Судья не вернул вердикт: /.exec(s);
    if (m) return t('Судья не вернул вердикт: {error}', { error: s.slice(m[0].length) });
    if (s === 'ошибка судьи') return t(s);
  }
  if (is('none') && s === 'фиксированное число итераций') return t(s);
  return s;
}
