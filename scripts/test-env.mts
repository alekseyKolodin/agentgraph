// Подгружается в каждый процесс `npm test` (--import): папка настроек — временная, а не ~/.agentgraph.
// Без этого тест, забывший подменить хранилище (доска, рутины, ключи), пишет в настоящие данные человека: так на
// настоящую доску попало дело «Баг 1» из теста рутины. Тест, которому нужна своя папка, по-прежнему ставит её сам.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-test-cfg-'));
process.env.AGENTGRAPH_CONFIG_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
