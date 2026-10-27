// Английский словарь: ai. Ключ — русский текст из t() как есть.
export const ai: Record<string, string> = {
  // ход ИИ над flow (lib/flow/ai-progress.ts, components/AiProgress.tsx)
  'подключаюсь': 'connecting',
  'генерирую flow': 'generating the flow',
  'правка': 'editing',
  'исправляю ошибки валидации {n}/{of}': 'fixing validation errors {n}/{of}',
  'API не ответил, повтор {n} из {of} через {s} с': 'The API did not respond, retry {n} of {of} in {s} s',
  'API не ответил, повтор {n} из {of}…': 'The API did not respond, retry {n} of {of}…',
  'по умолчанию ({model})': 'default ({model})',
  'Модель сессии: {model}': 'Session model: {model}',
  'Модель станет известна, когда сессия запустится': 'The model will be known once the session starts',
  'модель…': 'model…',
  'Сколько идёт': 'Elapsed',
  'Остановить сессию: траты прекратятся, flow не изменится': 'Stop the session: spending stops, the flow stays as it was',
  'Генератор работает без инструментов: думает молча и присылает flow целиком в конце.':
    'The generator works without tools: it thinks silently and sends the whole flow at the end.',
  'Здесь появятся шаги ИИ: чтение и правки файла flow.': 'The AI\'s steps will appear here: reading and editing the flow file.',
  'Нет вестей {time}. Модель может долго думать молча; если это дольше обычного — прерви и попробуй снова.':
    'No news for {time}. The model may think silently for a long time; if this takes longer than usual, abort and try again.',
  'Модель ИИ': 'AI model',
  'Модель, которая генерирует и правит flow. «По умолчанию» — модель Claude Code по умолчанию.':
    'The model that generates and edits the flow. "Default" is Claude Code\'s default model.',
  'Модель, которая генерирует и правит flow. «По умолчанию» — модель Claude Code по умолчанию, сейчас {model}.':
    'The model that generates and edits the flow. "Default" is Claude Code\'s default model, currently {model}.',
  'Сервер оборвал ответ без результата': 'The server cut the response off without a result',

  // «Новый flow» (screens/flow/NewFlowDialog.tsx)
  'Черновик {name} готов — открыть': 'Draft {name} is ready — open it',
  'Flow {name} готов — открыть': 'Flow {name} is ready — open it',
  'Генерация прервана': 'Generation aborted',
  'Новый flow не создан: {error}': 'The new flow was not created: {error}',
  'Черновик {name} готов': 'Draft {name} is ready',
  'Flow {name} готов': 'Flow {name} is ready',
  'Flow сгенерирован: {facts}': 'Flow generated: {facts}',
  'Генерация продолжится в этой вкладке; когда flow будет готов, внизу справа появится уведомление':
    'Generation continues in this tab; when the flow is ready, a notification appears at the bottom right',

  // «Правка с ИИ» (screens/flow/Builder.tsx)
  'Модель: {model}': 'Model: {model}',
};
