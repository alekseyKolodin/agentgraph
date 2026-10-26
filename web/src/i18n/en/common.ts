// Английский словарь: общие форматтеры и статусы (lib/format.ts). Ключ — русский текст из t() как есть.
export const common: Record<string, string> = {
  '{s}с': '{s}s',
  '{m}м {s}с': '{m}m {s}s',
  'меньше минуты': 'less than a minute',
  '{m} мин': '{m} min',
  '{h} ч {m} мин': '{h} h {m} min',
  'только что': 'just now',
  '{m} мин назад': '{m} min ago',
  'без проекта': 'no project',
  // статусы запуска
  'выполняется': 'running',
  'ждёт ответа': 'waiting for reply',
  'готово': 'done',
  'лимит итераций': 'iteration limit',
  'ошибка': 'error',
  'лимит стоимости': 'cost limit',
  'прервано': 'aborted',
  'ожидает': 'pending',
  'на паузе': 'paused',
  'оборвался': 'interrupted',
};
