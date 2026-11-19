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
import { session } from './session';
import { space } from './space';
import { teamwork } from './teamwork';
import { routines } from './routines';
import { routineGraph } from './routine-graph';
import { assistant } from './assistant';
import { kinds } from './kinds';
import { sources } from './sources';
import { deskTop } from './desk-top';
import { deskMonth } from './desk-month';
import { deskDetail } from './desk-detail';
import { graph } from './graph';
import { flowRun } from './flow-run';

export const EN: Record<string, string> = { ...kinds, ...common, ...shell, ...home, ...flow, ...launch, ...run, ...runart, ...misc, ...chat, ...ai, ...fix, ...compose, ...session, ...space, ...teamwork, ...routines, ...routineGraph, ...assistant, ...sources, ...deskTop, ...deskMonth, ...deskDetail, ...graph, ...flowRun };
