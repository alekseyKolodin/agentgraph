import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLangForTest } from '../i18n';
import { runnerText } from './runner-text';

test('тексты раннера: по-русски как есть; по-английски — маркер, команда с выводом, судья; чужой текст не трогается', () => {
  const cmd = 'Команда `npm test` завершилась с кодом 1. Вывод (хвост):\n✖ 1 failed {x}';
  assert.equal(runnerText(cmd), cmd);
  setLangForTest('en');
  try {
    assert.equal(runnerText('маркер <CLEAN> последней строкой вывода fix: нет'), 'marker <CLEAN> as the last line of fix: no');
    assert.equal(runnerText(cmd), 'Command `npm test` exited with code 1. Output (tail):\n✖ 1 failed {x}');
    assert.equal(runnerText('Судья не вернул вердикт: timeout'), 'The judge returned no verdict: timeout');
    assert.equal(runnerText('фиксированное число итераций'), 'fixed number of iterations');
    assert.equal(runnerText('Я прочитал файл'), 'Я прочитал файл');
    assert.equal(runnerText('маркер <ALL DONE> последней строкой вывода fix: есть', 'marker'), 'marker <ALL DONE> as the last line of fix: yes');
    // вердикт судьи не трогается, даже если похож на текст раннера другого типа
    assert.equal(runnerText(cmd, 'judge'), cmd);
    assert.equal(runnerText(undefined), '');
  } finally {
    setLangForTest('ru');
  }
});
