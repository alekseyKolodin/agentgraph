// Английский словарь: space — пространства (фича или проект: карта, документы, состояние) и всё, что сменило теги
// задач, — выбор пространства в формах запуска и сессии, строка сессии, «Итог» запуска, страница «Знания».
// Ключ — русский текст из t() как есть.
export const space: Record<string, string> = {
  'без пространства — выбери или впиши новый слаг': 'no space — pick one or type a new slug',
  'Без пространства': 'No space',
  '+ Новое пространство «{slug}»': '+ New space “{slug}”',
  'знания, вложения, директории, worktree, лимиты, модель': 'knowledge, attachments, directories, worktree, limits, model',
  'из пространства «{name}»: его рабочая папка': 'from space “{name}”: its working folder',
  'из пространства «{name}»: папка его последней сессии': 'from space “{name}”: the folder of its latest session',
  'из пространства «{name}»: папка его последнего запуска': 'from space “{name}”: the folder of its latest run',
  'Пространство {slug} уже есть: открой его в списке': 'Space {slug} already exists: open it in the list',
  'Где идёт работа: её подставят формы сессии и запуска при выборе пространства. Можно не задавать — тогда подставится папка последней сессии или запуска в нём': 'Where the work happens: the session and run forms fill it in when the space is picked. Optional — without it they use the folder of the latest session or run in the space',
  'Рабочая папка': 'Working folder',
  'Рабочая папка пространства': 'Working folder of the space',
  'Папка: {path}': 'Folder: {path}',
  'Где идёт работа: её подставят формы сессии и запуска при выборе пространства. Пусто — папка последней сессии или запуска в нём': 'Where the work happens: the session and run forms fill it in when the space is picked. Empty — the folder of the latest session or run in the space',
  'Формы сессии и запуска подставят её при выборе пространства': 'The session and run forms fill it in when the space is picked',
  'Не задана: формы подставят папку последней работы — {path}': 'Not set: the forms use the folder of the latest work — {path}',
  'Не задана, работы в пространстве ещё не было: формы оставят свою папку': 'Not set, and there was no work in the space yet: the forms keep their own folder',
  'запись в папку пространства': 'a write to a space folder',
  'запись в папку тегов знаний': 'a write to the knowledge tags folder',
  // сайдбар и бейджи
  'Пространства': 'Spaces',
  'Пространства: фича или проект — карта (CLAUDE.md), документы, состояние «где мы сейчас», все их сессии и запуски':
    'Spaces: a feature or a project — a map (CLAUDE.md), documents, the "where we are now" state, all their sessions and runs',
  'Знания': 'Knowledge',
  'Теги знаний: правила и справка для этапов flow и сессий — строка в промпте, полный текст по запросу':
    'Knowledge tags: rules and references for flow phases and sessions — one line in the prompt, the full text on request',
  'Обычная сессия Claude Code в терминале, в пространстве и с тегами знаний': 'A regular Claude Code session in a terminal, in a space and with knowledge tags',
  'Тег задачи старого запуска: теперь пространство {slug}': 'Task tag of an old run: now the {slug} space',
  'Пространство: карта, документы, состояние «где мы сейчас»': 'Space: map, documents, the "where we are now" state',

  // выбор пространства в формах
  'Пространство': 'Space',
  'Без пространства: только папка и теги знаний': 'No space: just the folder and knowledge tags',
  'Слаг пространства: строчные латинские буквы, цифры и дефис': 'Space slug: lowercase Latin letters, digits and hyphens',
  '{slug}: новое пространство — заведётся пустым, карту заполнишь на его странице': '{slug}: a new space — it will be created empty, fill in the map on its page',
  'карта — памятью': 'map as memory',
  'карты нет': 'no map',
  'документов: {n}': 'documents: {n}',
  'состояние — в контексте': 'state in context',
  'состояния ещё нет': 'no state yet',
  'Фича или проект: карта (CLAUDE.md) придёт памятью, как CLAUDE.md репозитория; документы — по запросу; состояние «где мы сейчас» — в контексте. После работы состояние перепишет короткая сессия':
    'A feature or a project: the map (CLAUDE.md) arrives as memory, like a repository\'s CLAUDE.md; documents on request; the "where we are now" state in context. After the work a short session rewrites the state',
  'без пространства — или выбери из списка, или впиши новый слаг: press-alert': 'no space — or pick one from the list, or type a new slug: press-alert',

  // «Итог» запуска и окно файла
  'Состояние пространства · {slug}': 'Space state · {slug}',
  'Состояния пока нет': 'No state yet',
  'обновляю состояние пространства {space}…': 'updating the {space} space state…',
  'Состояние пространства обновлено': 'Space state updated',
  'Состояние не обновлено: {why}': 'State not updated: {why}',
  'Состояние не обновлено': 'State not updated',
  'Пространство не заведено: {why}': 'Space not created: {why}',
  'заведено автоматически': 'created automatically',
  'состояние': 'state',

  // форма запуска
  'пространство, знания, вложения, директории, worktree, лимиты, модель': 'space, knowledge, attachments, directories, worktree, limits, model',
  'Тега знаний {slug} нет: заведи его на странице «Знания»': 'There is no {slug} knowledge tag: create it on the "Knowledge" page',
  'Завожу пространство и запускаю…': 'Creating a space and starting…',
  'Пространство не заведено: {err}. Запуск идёт без пространства.': 'Space not created: {err}. The run goes without a space.',
  'Что сервер допишет в конец промпта каждого этапа; карта пространства придёт памятью. Поле «Задача» остаётся только задачей':
    'What the server appends to the end of every phase prompt; the space map arrives as memory. The "Task" field stays just the task',
  'в конец промптов этапов · карта — памятью': 'to the end of phase prompts · map as memory',
  'После запуска со статусом «готово» короткая сессия перепишет состояние пространства: суть, где код, решения, где читать подробнее':
    'After a run with the "done" status a short session rewrites the space state: gist, where the code is, decisions, where to read more',
  'Обновить состояние пространства после запуска': 'Update the space state after the run',
  'ИИ по тексту задачи заведёт новое пространство (слаг занят — с суффиксом -2…), после «готово» запишет его состояние. Существующие не переиспользуются: чтобы продолжить фичу, выбери её пространство в поле выше':
    'AI creates a new space from the task text (a taken slug gets a -2… suffix) and writes its state after "done". Existing spaces aren\'t reused: to continue a feature, pick its space in the field above',
  'Завести пространство автоматически': 'Create a space automatically',
  'Что должны знать этапы (фронтенд, бэкенд, QA): в промпт каждого блока уйдёт строка с описанием, полный текст этап возьмёт инструментом knowledge_read. Тегов может быть несколько. Заводят и правят их на странице «Знания»':
    'What the phases should know (frontend, backend, QA): every block\'s prompt gets a line with the description, the phase takes the full text with the knowledge_read tool. There can be several tags. They are created and edited on the "Knowledge" page',
  'без тегов — или выбери тег знаний из списка и нажми Enter': 'no tags — or pick a knowledge tag from the list and press Enter',
  'Что сервер допишет в конец промптов этапов каждого блока от выбранных тегов знаний': 'What the server appends to the end of the phase prompts of every block from the chosen knowledge tags',
  'в конец промптов этапов каждого блока': 'to the end of the phase prompts of every block',

  // сессии
  'Модель увидит это со следующим своим шагом или твоим сообщением': 'The model will see this with its next step or your message',
  'Пространства {slug} больше нет: сессия идёт без него': 'The {slug} space is gone: the session goes without it',
  'Пространство: карта (CLAUDE.md) — памятью, документы — по запросу, состояние — в контексте': 'Space: the map (CLAUDE.md) as memory, documents on request, the state in context',
  'Раздел придёт со следующим шагом; карту в память — «Перезапустить» в меню ⋯': 'The section arrives with the next step; for the map in memory — "Restart" in the ⋯ menu',
  'Состояние уже пишется': 'The state is already being written',
  'Новых ходов с прошлого обновления нет': 'No new turns since the last update',
  'Сессия haiku перепишет состояние пространства по ходам после прошлого обновления': 'A haiku session rewrites the space state from the turns since the last update',
  'Состояние пространства: пишу…': 'Space state: writing…',
  'Состояние не обновлено: приложение закрыли': 'State not updated: the app was closed',
  'При выходе из приложения состояние не пишется: обнови его кнопкой': 'The state isn\'t written when the app quits: update it with the button',
  'Состояние не записано: ошибка': 'State not written: error',
  'Состояние записано в {space} · {time}': 'State written to {space} · {time}',
  'Состояние пространства: не обновлялось': 'Space state: not updated yet',
  'Обновить состояние': 'Update state',
  'Выбрать пространство': 'Choose a space',
  'Раздел пространства придёт со следующим шагом; карту в память — «Перезапустить» в меню ⋯': 'The space section arrives with the next step; for the map in memory — "Restart" in the ⋯ menu',
  'Пространство получит «Продолжить»': '"Continue" will get the space',
  '+ пространство': '+ space',
  'Снять пространство {slug}': 'Remove the {slug} space',
  'Перезапустить': 'Restart',
  'claude перезапустится тем же разговором (--resume): карта пространства, выбранного на ходу, придёт памятью, а папки пространства и тегов станут доступны без вопросов':
    'claude restarts with the same conversation (--resume): the map of a space chosen on the fly arrives as memory, and the space and tag folders become readable without asking',
  'Тот же разговор (claude --resume) с текущими пространством и тегами и пересчитанными папками': 'The same conversation (claude --resume) with the current space and tags and recomputed folders',
  '«Продолжить» откроет тот же разговор (claude --resume) с текущими пространством и тегами и пересчитанными папками.':
    '"Continue" opens the same conversation (claude --resume) with the current space and tags and recomputed folders.',
  'Тот же разговор (claude --resume) с текущими пространством и тегами': 'The same conversation (claude --resume) with the current space and tags',
  'Claude спрашивает в терминале, доверяешь ли ты этой папке: пока не ответишь, контекст agentgraph не придёт.':
    'Claude is asking in the terminal whether you trust this folder: until you answer, the agentgraph context won\'t arrive.',
  'agentgraph передаёт контекст хуками Claude Code. Их выключают настройки disableAllHooks и allowedHttpHookUrls, а HTTP-хуки не доходят через прокси, если 127.0.0.1 не в NO_PROXY.':
    'agentgraph delivers context through Claude Code hooks. The disableAllHooks and allowedHttpHookUrls settings turn them off, and HTTP hooks don\'t get through a proxy unless 127.0.0.1 is in NO_PROXY.',
  'Контекст не доставлен: хук SessionStart не сработал. Возможные причины — прокси, disableAllHooks или allowedHttpHookUrls в настройках Claude Code.':
    'Context not delivered: the SessionStart hook didn\'t fire. Possible causes — a proxy, disableAllHooks or allowedHttpHookUrls in the Claude Code settings.',
  'Claude вышел, не начав сессию: доверие к папке не принято. Контекст agentgraph не доставлялся.': 'Claude exited without starting the session: folder trust was not accepted. The agentgraph context was not delivered.',
  'Обычная сессия Claude Code в терминале — без flow, но в пространстве и с тегами знаний.': 'A regular Claude Code session in a terminal — no flow, but in a space and with knowledge tags.',
  'правила для этой работы: выбери тег знаний и нажми Enter': 'rules for this work: pick a knowledge tag and press Enter',
  'Строка каждого тега — в контексте, полный текст Claude возьмёт инструментом knowledge_read. Можно и без тегов.':
    'Each tag\'s line goes into the context, Claude takes the full text with the knowledge_read tool. Tags are optional.',
  'по пространству или папке': 'from the space or the folder',
  'Обновлять состояние пространства при выходе': 'Update the space state on exit',
  'Короткая сессия haiku перепишет «где мы сейчас» по ходам этой сессии, как после запуска flow. Можно и вручную — кнопкой в сессии.':
    'A short haiku session rewrites "where we are now" from this session\'s turns, like after a flow run. You can also do it by hand — with the button in the session.',
  'Пространство и теги': 'Space and tags',
  'состояние не обновлено: приложение закрыли': 'state not updated: the app was closed',

  // страница «Пространства»
  'Карта': 'Map',
  'Состояние': 'State',
  'Документы': 'Documents',
  'Настройки': 'Settings',
  'Пространства {slug} нет': 'There is no {slug} space',
  'Взять версию с диска? Твои несохранённые правки пропадут.': 'Take the version from disk? Your unsaved edits will be lost.',
  'Фича или проект, над которыми идут сессии и запуски: своя карта (CLAUDE.md), документы и состояние «где мы сейчас». Выбери пространство при старте сессии или запуска — агент получит карту памятью, как CLAUDE.md репозитория':
    'A feature or a project that sessions and runs work on: its own map (CLAUDE.md), documents and the "where we are now" state. Pick a space when starting a session or a run — the agent gets the map as memory, like a repository\'s CLAUDE.md',
  'Все пространства': 'All spaces',
  '+ Новое пространство': '+ New space',
  'Пуш-тревога': 'Push alert',
  'Одна строка в начале карты: что за фича и зачем. Карту дополнишь после создания': 'One line at the top of the map: what the feature is and why. Fill in the rest of the map after creating it',
  'Суть': 'Gist',
  'Пуш о тревоге на Android и iOS, бэкенд отправки': 'Alert push on Android and iOS, the sending backend',
  'Репозитории и папки фичи, по одному на строку: сессии и этапы получат их на чтение, а карта — список «Где что»':
    'The feature\'s repositories and folders, one per line: sessions and phases get read access, and the map gets a "Where things are" list',
  'Папки': 'Folders',
  'Выбери папку пространства': 'Choose a space folder',
  'Завести пространство': 'Create space',
  'Поиск: слаг, заголовок, состояние': 'Search: slug, title, state',
  'Все слова должны найтись в слаге, заголовке или начале состояния. Esc — очистить': 'Every word must be found in the slug, title or the start of the state. Esc clears',
  'из тега задачи': 'from a task tag',
  'Выбери пространство в списке — откроются его карта, состояние, документы и все его сессии и запуски. Новое — кнопкой «+ Новое пространство»; его можно вписать и прямо в форме сессии или запуска.':
    'Pick a space in the list — its map, state, documents and all its sessions and runs will open. A new one — with the "+ New space" button; you can also type it right in the session or run form.',
  'Перенесено из тега задачи {tag}: его папка осталась на месте': 'Moved from the {tag} task tag: its folder stayed in place',
  'Новая сессия Claude Code в терминале в этом пространстве: карта — памятью, состояние и документы — в контексте':
    'A new Claude Code session in a terminal in this space: the map as memory, the state and documents in context',
  'Сессия в самой папке пространства: Claude правит карту и документы как обычный проект, ты подтверждаешь правки':
    'A session in the space folder itself: Claude edits the map and documents like a regular project, you approve the edits',
  'Сессия в папке': 'Session in the folder',
  'Перечитать с диска': 'Reload from disk',
  'Сохранить карту, состояние и настройки (⌘S)': 'Save the map, state and settings (⌘S)',
  'CLAUDE.md пространства — карта: суть, где что, куда за чем ходить, договорённости. Claude Code загружает её памятью в каждую сессию и этап пространства, как CLAUDE.md репозитория. Держи её короткой: подробности — в документы, их агент откроет сам':
    'The space\'s CLAUDE.md is its map: the gist, where things are, where to go for what, agreements. Claude Code loads it as memory into every session and phase of the space, like a repository\'s CLAUDE.md. Keep it short: details go into documents, the agent opens them itself',
  'Карта длинная: она уходит в каждый запрос модели — вынеси подробности в документы': 'The map is long: it goes into every model request — move the details into documents',
  'Карту правишь ты; агент её не меняет — только сессия в папке пространства с твоим подтверждением': 'You edit the map; the agent doesn\'t change it — only a session in the space folder, with your approval',
  'Суть · Где код · Ключевые решения · Что осталось · Где читать подробнее': 'Gist · Where the code is · Key decisions · What\'s left · Where to read more',
  'Длиннее {n} знаков — обрежется при сохранении': 'Longer than {n} characters — it will be cut on save',
  '«Где мы сейчас»: его переписывает короткая сессия после сессии терминала и запуска «готово» в пространстве; правка руками доживёт до следующей такой записи. Модели оно идёт как данные, а не как инструкции':
    '"Where we are now": a short session rewrites it after a terminal session and a "done" run in the space; a manual edit lasts until the next such write. The model gets it as data, not as instructions',
  'Абсолютные пути к папкам или файлам, по одному на строку: сессии и этапы пространства получат их на чтение (--add-dir с запретом записи; в запуске — доп. директориями). Несуществующие пропускаются':
    'Absolute paths to folders or files, one per line: the space\'s sessions and phases get read access (--add-dir with writes denied; in a run — as additional directories). Missing ones are skipped',
  'Папки (только чтение)': 'Folders (read-only)',
  'Папка пространства: {dir}. Запись в неё у сессий закрыта (документ пишется инструментом space_write с твоим подтверждением), у этапов запуска — тоже.':
    'Space folder: {dir}. Sessions can\'t write to it (a document is written with the space_write tool after your approval), and neither can run phases.',
  'Сессии и запуски пространства': 'Sessions and runs of the space',
  'Сессии и запуски': 'Sessions and runs',
  'сессия': 'session',
  'по тегу задачи': 'via a task tag',
  'Сессий и запусков в этом пространстве ещё не было.': 'There have been no sessions or runs in this space yet.',
  'Документы добавлены': 'Documents added',
  'В документе есть несохранённые правки. Открыть другой?': 'The document has unsaved edits. Open another one?',
  'Удалить документ {name}?': 'Delete the {name} document?',
  'Спеки, решения, заметки, макеты. В контекст идёт только список с заголовками «# …» — файл агент открывает сам, когда нужен. Сессия может записать .md или .txt инструментом space_write, спросив тебя':
    'Specs, decisions, notes, mockups. Only the list with the "# …" headings goes into the context — the agent opens a file itself when needed. A session can write .md or .txt with the space_write tool after asking you',
  'Картинки, PDF и текстовые файлы: до 10 МБ каждый, до 25 МБ вместе, до 30 файлов': 'Images, PDFs and text files: up to 10 MB each, up to 25 MB together, up to 30 files',
  '+ Загрузить файлы…': '+ Upload files…',
  'новый документ: decisions': 'new document: decisions',
  'В Finder': 'In Finder',
  'Документов пока нет.': 'No documents yet.',
  'Сохранить документ': 'Save document',
  'Закрыть без сохранения?': 'Close without saving?',
  'Собираю…': 'Collecting…',
  'Памятью (CLAUDE.md)': 'As memory (CLAUDE.md)',
  '{path} — {n} знаков, в каждом запросе': '{path} — {n} characters, in every request',
  'карты нет — в память ничего не идёт': 'no map — nothing goes into memory',
  'Листинг Claude Code со страницы «Контекст»: карта пространства среди файлов памяти, с токенами': 'The Claude Code listing from the "Context" page: the space map among the memory files, with tokens',
  'Токены в «Контексте»': 'Tokens in "Context"',
  'На чтение': 'Read access',
  'Сессия терминала — в начале разговора (хук SessionStart)': 'Terminal session — at the start of the conversation (SessionStart hook)',
  'Этап запуска — в конце промпта каждого этапа': 'Run phase — at the end of every phase prompt',
  'карта': 'map',
  'без карты': 'no map',
  'пространство без карты и состояния': 'a space without a map or state',
  'Пространств пока нет — заведи первое выше': 'No spaces yet — create the first one above',
  'сессия «{name}»': 'session «{name}»',
  'запуск {flow}': 'run {flow}',
  'Обновил: {who}': 'Updated by: {who}',
  'Состояние правили только руками': 'The state has only been edited by hand',
  'Состояние запишет короткая сессия после первой сессии или запуска «готово» в этом пространстве': 'A short session writes the state after the first session or "done" run in this space',
  'В пространстве есть несохранённые правки. Перейти без сохранения?': 'The space has unsaved edits. Leave without saving?',
  'Удалить пространство {slug}: карту, состояние и документы? Сессии и запуски с ним останутся, но новые его не получат.':
    'Delete the {slug} space: map, state and documents? Sessions and runs with it stay, but new ones won\'t get it.',
  '# Название фичи или проекта\n\nСуть: что делаем и зачем, в двух фразах.\n\n## Где что\n- ~/code/android — клиент, экран тревоги в feature/alert\n- ~/code/api — бэкенд, эндпоинт /alerts\n\n## Куда за чем ходить\n- спека — docs/spec.md\n\n## Договорённости\n- …':
    '# Feature or project name\n\nGist: what we\'re doing and why, in two sentences.\n\n## Where things are\n- ~/code/android — the client, the alert screen in feature/alert\n- ~/code/api — the backend, the /alerts endpoint\n\n## Where to go for what\n- the spec — docs/spec.md\n\n## Agreements\n- …',
  'сессия|сессии|сессий': 'session|sessions',

  // страница «Контекст»
  'Пространство сессии или запуска: его папка уйдёт доп. директорией, карта (CLAUDE.md) — в файлы памяти': 'The space of a session or run: its folder goes in as an additional directory, the map (CLAUDE.md) — into the memory files',
  'без пространства': 'no space',
  'пространство {space}': 'space {space}',

  // страница «Знания»
  'Тегов знаний пока нет — заведи первый выше': 'No knowledge tags yet — create the first one above',
  'Удалить тег знаний {slug}: заметки, пути и вложения? Flow, где он в knowledge, перестанут запускаться, пока его не уберут.':
    'Delete the {slug} knowledge tag: notes, paths and attachments? Flows that list it in knowledge will fail to start until it\'s removed.',
  'Теги знаний: правила и справка, которые нужны многим задачам (фронтенд, бэкенд, QA). Этапы блоков с knowledge и сессии получают строку с описанием, полный текст — инструментом knowledge_read. Фичи и проекты живут в «Пространствах»':
    'Knowledge tags: rules and references many tasks need (frontend, backend, QA). Phases of blocks with knowledge and sessions get a line with the description, the full text — with the knowledge_read tool. Features and projects live in "Spaces"',
  'Все теги знаний': 'All knowledge tags',
  'Правила QA': 'QA rules',
  'Поиск: слаг, заголовок, описание': 'Search: slug, title, description',
  'Все слова должны найтись в слаге, заголовке или описании. Esc — очистить': 'Every word must be found in the slug, title or description. Esc clears',
  'Выбери тег в списке — откроются его описание, заметки, пути и вложения. Новый тег — кнопкой «+ Новый тег»; к блоку flow тег подключают полем knowledge, к запуску и сессии — в их формах.':
    'Pick a tag in the list — its description, notes, paths and attachments will open. A new tag — with the "+ New tag" button; a tag is attached to a flow block with the knowledge field, to a run and a session — in their forms.',
};
