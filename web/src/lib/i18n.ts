// Язык интерфейса: русский (исходный) или английский. Ключ перевода — сам русский текст: без словаря и в тестах
// интерфейс остаётся русским. Язык читается один раз при загрузке страницы; переключение перезагружает её
// (setLang в Sidebar), поэтому t() можно звать и при инициализации модулей. Сообщения сервера не переводятся.
import { EN } from '../i18n/en';
import { LS } from './storage';

export type Lang = 'ru' | 'en';

/** Ключ localStorage: строка 'ru' | 'en'. Нет значения — русский, как было до переключателя. */
export const LANG_KEY = 'agentgraph.lang';

let lang: Lang = LS.raw(LANG_KEY) === 'en' ? 'en' : 'ru';

export const getLang = (): Lang => lang;

/** Для тестов: переключить язык без перезагрузки. */
export const setLangForTest = (l: Lang): void => {
  lang = l;
};

/** Запомнить язык; применится после перезагрузки страницы. */
export const saveLang = (l: Lang): void => LS.setRaw(LANG_KEY, l);

/** Локаль дат и чисел. */
export const locale = (): string => (lang === 'en' ? 'en-GB' : 'ru-RU');

/**
 * Перевод: t('Пауза') → «Pause» на английском. Переменные — в фигурных скобках, ключ пишется с ними:
 * t('{n} мин назад', { n: 5 }). Перевода нет — русский текст. ctx различает одинаковый русский текст
 * с разным смыслом: t('Отменить', undefined, 'undo') ищет сначала ключ 'Отменить#undo'.
 */
export function t(ru: string, vars?: Record<string, string | number>, ctx?: string): string {
  const s = lang === 'en' ? ((ctx ? EN[`${ru}#${ctx}`] : undefined) ?? EN[ru] ?? ru) : ru;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/**
 * Форма слова по числу. По-русски — одна из трёх форм; по-английски — перевод ключа «one|few|many»
 * вида «question|questions»: первая форма для 1, вторая для остальных.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  if (lang === 'en') {
    const en = EN[`${one}|${few}|${many}`];
    if (en) {
      const [single, other] = en.split('|');
      return (n === 1 ? single : other ?? single)!;
    }
  }
  return n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
}
