// «Правка» → YAML: текст flow целиком и «Сохранить» (у черновика — «Применить» через проверку на сервере).
import { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkFlow, errorText, keys, saveFlowYaml } from '../../api';
import { t } from '../../lib/i18n';
import { applySaved, dropYamlVersion, flowState, msgClass, saveStart, set, useFlowStore } from './store';
import { YamlEditor, type YamlEditorHandle } from './YamlEditor';
import styles from './Flow.module.css';

/** Вкладка YAML: редактор и «Сохранить» (у черновика — «Применить» через проверку на сервере). */
export function YamlView({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const qc = useQueryClient();
  const editor = useRef<YamlEditorHandle>(null);
  const save = async () => {
    const text = editor.current?.value() ?? '';
    const draft = Boolean(flowState.flow?.draft);
    const start = saveStart();
    try {
      const r = draft ? await checkFlow({ yaml: text }) : await saveFlowYaml(flowState.flow!.name, text);
      // пока сохранялось, открыли другой flow — ответ ему не нужен
      if (applySaved(r, text, draft, start)) set({ yamlMsg: { text: draft ? t('Применено') : t('Сохранено'), tone: 'ok' } });
      if (!draft) await qc.invalidateQueries({ queryKey: keys.flows });
    } catch (err) {
      if (flowState.flow === start.flow) set({ yamlMsg: { text: errorText(err), tone: 'err' } });
    }
  };
  return (
    <section hidden={hidden}>
      <YamlEditor ref={editor} className={styles.yamlEditor} value={st.yamlFrom?.text ?? flow.yaml} seq={st.yamlSeq} />
      <div className="row">
        <button className="btn primary" onClick={() => void save()}>{flow.draft ? t('Применить') : t('Сохранить')}</button>
        {/* в редакторе — версия из снимка запуска: вернуть текст файла без сохранения */}
        {st.yamlFrom && <button type="button" className="btn ghost" onClick={dropYamlVersion}>{t('Вернуть текст flow')}</button>}
        <pre className={msgClass(st.yamlMsg)}>{st.yamlMsg.text}</pre>
      </div>
    </section>
  );
}

