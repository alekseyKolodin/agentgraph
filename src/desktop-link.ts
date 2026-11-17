// Ярлык checkout'а — AgentGraph.app, который запускают из Finder и держат в Dock (scripts/desktop-install.mts).
// Это копия Electron.app из node_modules со своим именем, значком и идентификатором, а вместо кода приложения в ней
// заглушка, которая грузит dist/desktop/main.js из checkout'а: код и данные остаются в нём, автообновление работает
// как у `npm run desktop:dev`. Здесь — что именно записать в копию, без Electron и без записи на диск.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LINK_APP_NAME = 'AgentGraph';
/**
 * Не dev.agentgraph.desktop: упакованное приложение (electron-builder.yml) может стоять рядом, у системы они разные.
 * Работать одновременно они при этом не станут: папка ~/Library/Application Support/AgentGraph у них общая, и второй
 * запущенный уступает первому (requestSingleInstanceLock в src/desktop/main.ts).
 */
export const LINK_BUNDLE_ID = 'dev.agentgraph.desktop.checkout';
/** Значок ярлыка в Contents/Resources. */
export const LINK_ICON = 'icon.icns';

/**
 * Правки Info.plist копии Electron.app: имя в Dock и меню, свой идентификатор (разрешение на уведомления — по нему), значок.
 * Версии agentgraph здесь нет нарочно: разрешения macOS (уведомления, доступ к «Документам») привязаны к подписи, а подпись —
 * к содержимому бандла. Пока Electron и путь checkout'а те же, повторная установка даёт тот же бандл, и macOS не спрашивает
 * заново. Версию в «О программе» ставит само приложение (src/desktop/main.ts).
 */
export function linkPlist(): [key: string, value: string][] {
  return [
    ['CFBundleName', LINK_APP_NAME],
    ['CFBundleDisplayName', LINK_APP_NAME],
    ['CFBundleIdentifier', LINK_BUNDLE_ID],
    ['CFBundleIconFile', LINK_ICON],
  ];
}

/**
 * Файлы заглушки в Contents/Resources/app. Не симлинк на checkout: ссылка наружу ломает строгую проверку подписи бандла.
 * Имя исполняемого файла остаётся Electron — приложение не считается упакованным (app.isPackaged), данные берутся из
 * checkout'а; productName — имя приложения и его папки в ~/Library/Application Support.
 */
export function linkStub(checkout: string): Record<string, string> {
  const main = pathToFileURL(path.join(checkout, 'dist', 'desktop', 'main.js')).href;
  return {
    'package.json': `${JSON.stringify({ name: 'agentgraph', productName: LINK_APP_NAME, type: 'module', main: 'main.js' }, null, 2)}\n`,
    'main.js': `// Ярлык checkout'а agentgraph (npm run desktop:install). Папку checkout'а перенесли — установи ярлык заново.\nimport ${JSON.stringify(main)};\n`,
  };
}

/** Куда ставить ярлык: «Программы», если туда можно писать, иначе ~/Applications. */
export function linkTargetDir(home: string, writable: (dir: string) => boolean): string {
  return writable('/Applications') ? '/Applications' : path.join(home, 'Applications');
}

/**
 * Ярлык работает на Electron, скопированном при установке. В checkout'е стоит другой (обновление сделало npm install) —
 * версии для подсказки «установи ярлык заново»; совпадают или пакета нет — undefined.
 */
export function linkedElectronDrift(running: string, load: (id: string) => { version?: string }): { running: string; installed: string } | undefined {
  let installed: string | undefined;
  try {
    installed = load('electron/package.json').version;
  } catch {
    return undefined;
  }
  return installed && installed !== running ? { running, installed } : undefined;
}
