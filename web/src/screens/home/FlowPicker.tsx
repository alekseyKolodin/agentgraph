// «Запустить…» у задачи, MR или ветки (ui/dash.js openFlowPicker, toFlow): выбор flow у кнопки → POST /api/intake →
// вкладка «Запуск» этого flow с готовым входом: вход едет в состоянии перехода (location.state.intake) на /flow/<имя>,
// форма запуска (screens/flow/RunForm.tsx) кладёт его в задачу, директорию и привязку к источнику.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorText, postIntake, useFlows, type IntakeTarget } from '../../api';
import { useToast } from '../../components/Toast';
import { pickerFlows, pickerPosition } from '../../lib/dash';
import { LS } from '../../lib/storage';
import styles from './Dash.module.css';

/** Открытый выбор: у какой кнопки и для какого источника; seq — каждое открытие заново (пустой фильтр). */
export type PickerState = { target: IntakeTarget; anchor: DOMRect; seq: number } | null;

let pickerSeq = 0;
/** Открыть выбор у кнопки «Запустить…». */
export const pickerAt = (target: IntakeTarget, btn: HTMLElement): PickerState => ({ target, anchor: btn.getBoundingClientRect(), seq: ++pickerSeq });

/** Состояние перехода на вкладку «Запуск» flow (читает форма запуска). */
export type RunTabState = { tab: 'run'; intake: Awaited<ReturnType<typeof postIntake>> };

const LAST_FLOW_KEY = 'agentgraph.lastFlow';

/** Источник → вход flow → переход на «Запуск». Подсказка flow из «нужно внимание» зовёт его сама, без выбора. */
export function useToFlow() {
  const navigate = useNavigate();
  const toast = useToast();
  return useCallback(
    async (name: string, target: IntakeTarget) => {
      let intake;
      try {
        intake = await postIntake(name, target);
      } catch (err) {
        toast(`Не удалось собрать вход: ${errorText(err)}`);
        return;
      }
      LS.setRaw(LAST_FLOW_KEY, name);
      void navigate(`/flow/${name}`, { state: { tab: 'run', intake } satisfies RunTabState });
    },
    [navigate, toast],
  );
}

export function FlowPicker({ state, onClose }: { state: PickerState; onClose: () => void }) {
  // каждое открытие — новый экземпляр: пустой фильтр, место у своей кнопки
  return state ? <PickerBox key={state.seq} state={state} onClose={onClose} /> : null;
}

function PickerBox({ state, onClose }: { state: NonNullable<PickerState>; onClose: () => void }) {
  const flows = useFlows().data ?? [];
  const toFlow = useToFlow();
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // место — по размеру со списком, до первого кадра; потом при фильтрации окно не прыгает (как в старом UI). Фокус в поле
  useLayoutEffect(() => {
    const el = box.current!;
    const pos = pickerPosition(state.anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    input.current?.focus();
  }, [state]);

  // клик мимо — закрыть; по другой «Запустить…» — она сама переоткроет выбор у себя
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      // кнопки «Запустить…» помечены data-to-flow
      if (!(e.target as Element).closest?.('[data-flow-picker], [data-to-flow]')) onClose();
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [onClose]);

  const list = pickerFlows(flows, query, LS.raw(LAST_FLOW_KEY));
  const pick = (name: string) => {
    onClose();
    void toFlow(name, state.target);
  };
  return (
    <div ref={box} className={styles.flowPicker} data-flow-picker="">
      <input
        ref={input}
        placeholder="Найти flow"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && list[0]) pick(list[0].name);
        }}
      />
      <ul>
        {list.length ? (
          list.map((f) => (
            <li key={f.name} onClick={() => pick(f.name)}>
              <span className={styles.name}>{f.name}</span>
              <span className={styles.sub}>{`${f.folder ? f.folder + ' · ' : ''}${f.description || ''}`}</span>
            </li>
          ))
        ) : (
          <li className="muted small">Ничего не нашлось</li>
        )}
      </ul>
    </div>
  );
}
