// Вкладка «Правка» экрана flow: сверху — плашка несохранённого (UnsavedBar), ниже слева схема (Builder) или текст YAML,
// справа — панель «Помощник | Этап N» (EditSide). Вид переключается сегментом над схемой; в YAML нет несохранённых
// правок схемы — переход туда с ними спрашивает. В YAML правая панель не нужна: там правят текст целиком.
import { useConfirm } from '../../components/ConfirmDialog';
import { t } from '../../lib/i18n';
import { Builder } from './Builder';
import { EditSide } from './EditSide';
import { flowState, set, useFlowStore, type EditView } from './store';
import { UnsavedBar } from './UnsavedBar';
import { YamlView } from './YamlView';
import styles from './Flow.module.css';

const VIEWS: readonly (readonly [EditView, string])[] = [['scheme', 'Схема'], ['yaml', 'YAML']];

export function EditTab({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const { askConfirm } = useConfirm();
  const scheme = st.editView === 'scheme';
  const pick = async (view: EditView) => {
    if (view === flowState.editView) return;
    if (view === 'yaml' && flowState.dirty && !(await askConfirm(t('В схеме есть несохранённые изменения, в YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    set({ editView: view });
  };
  return (
    <section hidden={hidden} className={styles.editTab}>
      {scheme && <UnsavedBar />}
      <div className={scheme ? styles.editSplit : undefined}>
        <div className={styles.editMain}>
          <div className={styles.editViews} role="group" aria-label={t('Вид')}>
            {VIEWS.map(([id, label]) => (
              <button key={id} type="button" className={st.editView === id ? styles.on : undefined} aria-pressed={st.editView === id} onClick={() => void pick(id)}>{t(label)}</button>
            ))}
          </div>
          <Builder hidden={!scheme} />
          <YamlView hidden={scheme} />
        </div>
        {scheme && st.flow && <EditSide />}
      </div>
    </section>
  );
}
