// Раздел «Код» (/code): все задачи Jira, MR и ветки подключённых проектов с «Запустить…» — раньше это было на главной
// («Задачи и код»), но целиком там оказалось лишним: на главной остались только MR, которым нужно внимание. Тело — Dash
// из screens/home (его же useIntegrations и LaunchButton берут формы запуска), «Подключения» — диалог оттуда же.
import { useCallback, useState } from 'react';
import { useFeature, useFlows, type IntakeTarget } from '../../api';
import { t } from '../../lib/i18n';
import { Dash } from '../home/Dash';
import { DashSettings } from '../home/DashSettings';
import { FlowPicker, pickerAt, type PickerState } from '../home/FlowPicker';

export function CodeScreen() {
  const on = useFeature('integrations');
  const [picker, setPicker] = useState<PickerState>(null);
  const [settings, setSettings] = useState(false);
  // список flow — заранее: выбор у «Запустить…» открывается сразу с ним
  useFlows();
  const onLaunch = useCallback((target: IntakeTarget, btn: HTMLElement) => setPicker(pickerAt(target, btn)), []);
  const closePicker = useCallback(() => setPicker(null), []);
  return (
    <>
      <header className="view-head">
        <div>
          <h1>{t('Код')}</h1>
          <p className="muted">{t('Задачи Jira, MR и ветки проектов. «Запустить…» заполнит форму запуска, запустишь сам')}</p>
        </div>
        {on && (
          <div className="row">
            <button className="btn" title={t('Jira Cloud и git-репозитории: откуда берутся задачи, MR и ветки')} onClick={() => setSettings(true)}>{t('Подключения')}</button>
          </div>
        )}
      </header>
      {on ? <Dash onLaunch={onLaunch} /> : <p className="muted">{t('Этот сервер не умеет подключения — перезапусти UI-сервер.')}</p>}
      <FlowPicker state={picker} onClose={closePicker} />
      {on && <DashSettings open={settings} onClose={() => setSettings(false)} />}
    </>
  );
}
