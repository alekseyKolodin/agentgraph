// Перед упаковкой (desktop:build): node-pty 1.1.0 кладёт spawn-helper без права на исполнение. sessions-pty.ts чинит
// это при загрузке, но в собранном приложении chmod уже поздно — права должны быть в node_modules до electron-builder.
// Пакета нет (необязательная зависимость не поставилась) — терминала в сборке не будет, это не ошибка.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fixSpawnHelper } from '../src/sessions-pty.js';

try {
  fixSpawnHelper(path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')));
} catch (err) {
  console.warn(`node-pty: ${err instanceof Error ? err.message : String(err)} — вкладки «Сессии» в сборке не будет`);
}
