// `npm run desktop:install`: ставит ярлык checkout'а — AgentGraph.app в «Программы» (или --dir <папка>), который
// запускают кликом и закрепляют в Dock. `npm run desktop:dev` для этого не годится: он запускает голый Electron.app из
// node_modules, и закреплённый в Dock значок открывает пустой Electron. Что именно пишется в ярлык — src/desktop-link.ts.
// Ярлык — копия Electron на момент установки: после обновления Electron в checkout'е установку повторяют (приложение
// само об этом скажет). Удалить ярлык — перенести AgentGraph.app в корзину; данные лежат в checkout'е.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LINK_APP_NAME, LINK_BUNDLE_ID, LINK_ICON, linkPlist, linkStub, linkTargetDir } from '../src/desktop-link.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg: string): never {
  console.error(`desktop:install: ${msg}`);
  process.exit(1);
}

/** Команда macOS; ошибка — её вывод и выход. */
function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} — ${(r.stderr || r.stdout || r.error?.message || `код ${r.status}`).trim()}`);
  return r.stdout;
}

if (process.platform !== 'darwin') fail('ярлык приложения ставится только на macOS; на других системах — npm run ui');

const { values } = parseArgs({ options: { dir: { type: 'string' } } });
const writable = (dir: string) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const dir = values.dir ? path.resolve(values.dir) : linkTargetDir(os.homedir(), writable);
const dest = path.join(dir, `${LINK_APP_NAME}.app`);
// собираем рядом и подменяем готовым: прерванная установка не оставит на месте ярлыка полкопии Electron
const work = path.join(dir, `.${LINK_APP_NAME}.app.tmp-${process.pid}`);
const plist = path.join(work, 'Contents', 'Info.plist');
const resources = path.join(work, 'Contents', 'Resources');

if (!fs.existsSync(path.join(ROOT, 'dist', 'desktop', 'main.js'))) fail('нет dist/desktop/main.js — сначала npm run build (npm run desktop:install делает это сам)');

// require('electron') в Node отдаёт путь к исполняемому файлу и докачивает бинарник, если его ещё нет
const electronExe = createRequire(import.meta.url)('electron') as string;
const electronApp = path.resolve(electronExe, '..', '..', '..');
if (!electronApp.endsWith('.app') || !fs.existsSync(electronApp)) fail(`не нашёл Electron.app рядом с ${electronExe}`);

if (fs.existsSync(dest)) {
  // чужое не трогаем: в «Программах» может лежать упакованное приложение из dmg
  const id = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(dest, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
  if (id !== LINK_BUNDLE_ID) fail(`${dest} уже есть, и это не ярлык checkout'а (${id || 'без идентификатора'}). Убери его или поставь ярлык в другую папку: npm run desktop:install -- --dir <папка>`);
  // заменить работающее приложение нельзя: его процесс держит файлы старой копии
  // pgrep -f читает шаблон как регулярное выражение: путь экранируем
  const running = path.join(dest, 'Contents', 'MacOS').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (spawnSync('pgrep', ['-f', running], { encoding: 'utf8' }).stdout.trim()) fail(`${LINK_APP_NAME} запущен — закрой его (Cmd+Q) и повтори`);
}
fs.mkdirSync(dir, { recursive: true });
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(1));

// -c: на APFS копия — клон, места на диске не занимает; симлинки фреймворков остаются симлинками
run('cp', ['-cR', electronApp, work]);

for (const [key, value] of linkPlist()) run('plutil', ['-replace', key, '-string', value, plist]);
// сверка default_app.asar нам не нужна: его в ярлыке нет
spawnSync('plutil', ['-remove', 'ElectronAsarIntegrity', plist]);
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
fs.copyFileSync(path.join(ROOT, 'build', 'icon.icns'), path.join(resources, LINK_ICON));

const app = path.join(resources, 'app');
fs.mkdirSync(app);
for (const [name, text] of Object.entries(linkStub(ROOT))) fs.writeFileSync(path.join(app, name), text);

// своя подпись (ad-hoc) под новый идентификатор: без неё система не свяжет с приложением разрешение на уведомления
run('codesign', ['--force', '--deep', '--sign', '-', work]);

// прежний ярлык (что это он, проверено выше) уступает место готовому
fs.rmSync(dest, { recursive: true, force: true });
fs.renameSync(work, dest);
// Finder и Dock перечитают имя и значок
fs.utimesSync(dest, new Date(), new Date());

console.log(`Готово: ${dest}`);
console.log(`Открой его из Finder или Spotlight («${LINK_APP_NAME}»). Закрепить: правый клик по значку в Dock → «Параметры» → «Оставить в Dock».`);
console.log('Код и данные — в этом checkout\'е; перенёс папку или обновился Electron — выполни npm run desktop:install ещё раз.');
