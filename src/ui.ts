// Минимальные ANSI-хелперы без зависимостей.
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
};
export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
export const fmtMs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}с` : `${Math.floor(ms / 60_000)}м ${Math.round((ms % 60_000) / 1000)}с`);
