// Типы помощника (docs/ASSISTANTS.md): один серверный механизм на все разделы, раздел задаёт знания и инструменты.
// Отсюда их берёт и веб-интерфейс (import type), поэтому здесь только типы.

/** read — помощник только смотрит; act — меняет что-то у человека (подключил источник, собрал flow, заполнил черновик). */
export type AssistantLevel = 'read' | 'act';

/** Шаг помощника в ленте: один вызов инструмента. */
export type AssistantStep = {
  id: string;
  at: string;
  /** Номер хода разговора (сообщение человека → шаги → ответ). */
  turn: number;
  tool: string;
  /** Что делает шаг — словами для человека. */
  label: string;
  level: AssistantLevel;
  state: 'run' | 'ok' | 'fail';
  /** Что происходит прямо сейчас у долгого шага. */
  note?: string;
  /** Итог шага одной-двумя строками (или причина неудачи). */
  detail?: string;
  /** Расход вложенных сессий модели, $ (сборка источника, flow, проверка на истории). */
  costUsd?: number;
  ms?: number;
};

export type AssistantMessage = {
  id: string;
  turn: number;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** У ответа помощника: фактическая модель хода и его расход (вместе с шагами). */
  model?: string;
  costUsd?: number;
};

/** Что помощник знает и умеет — показывается человеку до первого сообщения. */
export type AssistantAbout = {
  section: string;
  /** Модель по умолчанию; человек выбирает свою. */
  defaultModel: string;
  knows: string[];
  tools: Array<{ name: string; label: string; level: AssistantLevel }>;
  /** Что остаётся только за человеком. */
  onlyYou: string[];
};

/** R — результат раздела (у рутин — черновик для формы); resultRev растёт с каждым новым результатом. */
export type AssistantView<R = unknown> = {
  id: string;
  section: string;
  state: 'working' | 'idle' | 'error';
  /** Фактическая модель последнего хода, до его старта — выбор человека. */
  model: string;
  messages: AssistantMessage[];
  steps: AssistantStep[];
  costUsd: number;
  error?: string;
  result?: R;
  resultRev: number;
};
