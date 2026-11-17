// Перед e2e: свежая сборка UI в dist/web (сервер раздаёт её на /) — тот же скрипт, что перед `npm run ui`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function globalSetup(): void {
  execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts/ensure-web.mts')], { cwd: ROOT, stdio: 'inherit' });
}
