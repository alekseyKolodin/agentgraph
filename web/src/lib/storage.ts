// localStorage с JSON и без падений (приватный режим, переполнение): как LS в ui/app.js. Ключи общие со старым UI —
// он живёт на том же адресе, и запомненное (свёрнутые секции, прочитанная лента, «Мои» MR) переносится как есть.

export const LS = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* приватный режим */
    }
  },
  /** Сырая строка, без JSON: так agentgraph.lastFlow, agentgraph.cwd, agentgraph.mrMine хранил старый UI — формат не менять. */
  raw(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setRaw(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* приватный режим */
    }
  },
};
