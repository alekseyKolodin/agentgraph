// «Настройки flow» в правой панели «Правки» (бывшая шапка «Всех полей списком»): описание, задача по умолчанию, файлы
// запуска (артефакты — только просмотр), блоки flow с «Добавить блок» и «Добавить вызов flow».
import { useFeature } from '../../api';
import { blockLabel, isCall, newBlock, type EditSpec } from '../../lib/flow/edit';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { openBlockPane } from './actions';
import { markDirty } from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function FlowSettings({ spec }: { spec: EditSpec }) {
  return (
    <div className={styles.flowSettings}>
      <label>
        <span>{t('Описание flow')}</span>
        <input id="b-description" value={spec.description || ''} placeholder={t('Что делает этот flow')} onChange={(e) => { spec.description = e.target.value; markDirty(); }} />
      </label>
      <label>
        <span title={t('Подставится в {{input}}; при запуске можно переписать')}>{t('Задача по умолчанию')}</span>
        <textarea id="b-input" className={styles.flowInput} rows={8} value={spec.input || ''} onChange={(e) => { spec.input = e.target.value; markDirty(); }} />
      </label>
      <ArtifactsDecl spec={spec} />
      <div className={styles.pSection}>
        <div className={styles.pLabel}>{t('Блоки')}</div>
        <div className="chips">
          {spec.blocks.map((b, bi) => (
            <button key={bi} type="button" className="chip" onClick={() => openBlockPane(bi)}>
              {bi + 1}. {isCall(b) ? t('вызов {flow}', { flow: b.flow || '…' }) : blockLabel(b, bi)}
            </button>
          ))}
        </div>
        <div className={cx('row', styles.addBlock)}>
          <button
            type="button"
            className="btn small"
            title={t('Например, ещё один цикл со своим условием; начнётся, когда закончится предыдущий блок')}
            onClick={() => {
              newBlock(spec);
              markDirty();
              openBlockPane(spec.blocks.length - 1);
            }}
          >
            {t('Добавить блок')}
          </button>
          <button
            type="button"
            className="btn small"
            title={t('Блок, который запускает другой flow отдельным запуском и передаёт дальше его итог')}
            onClick={() => {
              newBlock(spec, '');
              markDirty();
              openBlockPane(spec.blocks.length - 1);
            }}
          >
            {t('Добавить вызов flow')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Файлы запуска (артефакты) flow: только просмотр, правка — во вкладке YAML или через помощника. */
function ArtifactsDecl({ spec }: { spec: EditSpec }) {
  const on = useFeature('artifacts');
  const entries = Object.entries(spec.artifacts || {});
  if (!on || !entries.length) return null;
  return (
    <div className={cx(styles.pSection, styles.artDecl)} id="b-art-decl" tabIndex={-1}>
      <div className={styles.artDeclHead}><span className={styles.pLabel}>{t('Файлы, которые ведут этапы')}</span><span className="muted small">{t('правка — в YAML или через помощника')}</span></div>
      <ul>
        {entries.map(([key, a]) => {
          const lines = a.initial ? String(a.initial).split('\n').filter((x, i, all) => i < all.length - 1 || x).length : 0;
          const notes = [a.file || `${key}.md`, a.initial !== undefined ? t('заготовка: {n} {word}', { n: lines, word: plural(lines, 'строка', 'строки', 'строк') }) : t('создаётся пустым'), a.decisions ? t('сюда пишутся ответы на паузы') : ''].filter(Boolean);
          return <li key={key}><b>{a.title || key}</b> <code>{key}</code> <span className="muted small">{notes.join(' · ')}</span></li>;
        })}
      </ul>
    </div>
  );
}
