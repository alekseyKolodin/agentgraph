// Имя запуска, которое дал человек (PUT /api/runs/:id/title): нормализация, как у имени сессии, и запись в run.json.
// Имя от модели (run-title.ts) пишет раннер; это — правка завершённого запуска: run.json идущего переписывает раннер,
// и сервер такой запуск сюда не пускает (finishedRun). Продолжение наследует имя, как и имя от модели.
import fs from 'node:fs';
import path from 'node:path';
import type { RunReport } from './runner.js';

/** Длина имени от человека — как у имени сессии (SESSION_NAME_MAX); имя от модели короче (TITLE_MAX). */
export const RUN_NAME_MAX = 80;

export class RunNameError extends Error {}

/** Имя из тела запроса: пробелы и переводы строк — одним пробелом, по краям обрезаны, не длиннее RUN_NAME_MAX. Пустое — ошибка. */
export function runName(raw: unknown): string {
  if (typeof raw !== 'string') throw new RunNameError('title — строка');
  const name = [...raw.replace(/\s+/g, ' ').trim()].slice(0, RUN_NAME_MAX).join('').trimEnd();
  if (!name) throw new RunNameError('Имя запуска пустое');
  return name;
}

/**
 * Записать имя в run.json: исходный файл, а не readReport — тот подменяет статус оборвавшегося запуска. Через временный
 * файл: оборванная запись не оставит запуск без run.json. Ответ — записанный отчёт (flow — для события списков).
 */
export function writeRunName(file: string, title: string): RunReport {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RunReport;
  raw.title = title;
  const tmp = path.join(path.dirname(file), `.run.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, file);
  return raw;
}
