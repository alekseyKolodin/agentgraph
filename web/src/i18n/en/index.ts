// Английский словарь интерфейса: русский текст → английский. Разбит по областям, чтобы правки не сталкивались.
// Ключи с переменными пишутся как в t(): '{n} мин назад'; формы plural — 'одна|две|пять' → 'one|other'.
import { common } from './common';
import { shell } from './shell';
import { home } from './home';
import { flow } from './flow';
import { run } from './run';
import { runart } from './runart';
import { launch } from './launch';
import { misc } from './misc';
import { chat } from './chat';
import { ai } from './ai';
import { fix } from './fix';
import { compose } from './compose';

export const EN: Record<string, string> = { ...common, ...shell, ...home, ...flow, ...launch, ...run, ...runart, ...misc, ...chat, ...ai, ...fix, ...compose };
