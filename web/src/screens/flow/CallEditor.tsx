// Связка flow в конструкторе: поля блока-вызова (какой flow вызвать и его задача) и правила развилки next у любого блока.
// Логика без React — lib/flow/edit.ts (callVariables, nextTargets, renameBlock); здесь только поля.
import { useRef } from 'react';
import { Link } from 'react-router';
import { useFlows } from '../../api';
import { callVariables, DEFAULT_CALL_INPUT, insertVar, NEXT_JUDGE, nextRules, nextTargets, untilFor, usesVar, type EditBlock, type EditNextRule } from '../../lib/flow/edit';
import { schemeSummary } from '../../lib/flow/summary';
import { t } from '../../lib/i18n';
import { afterRender } from './actions';
import { markDirty, useFlowStore } from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Блок-вызов: выбор flow, «Открыть», его состав и задача с чипами переменных. */
export function CallFields({ bi }: { bi: number }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  const flows = useFlows().data ?? [];
  const input = useRef<HTMLTextAreaElement>(null);
  // сам себя flow вызвать не может: его в списке нет; невалидные — видны, но выбрать их нельзя
  const options = flows.filter((f) => f.name !== st.flow?.name);
  const callee = flows.find((f) => f.name === b.flow);
  const text = b.input ?? DEFAULT_CALL_INPUT;
  const vars = callVariables(spec, bi);

  const insert = (key: string) => {
    const ta = input.current!;
    const r = insertVar(ta.value, key, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.selectionStart ?? ta.value.length);
    if (r.text !== b.input) {
      b.input = r.text;
      markDirty();
    }
    afterRender(() => {
      ta.focus();
      ta.setSelectionRange(r.select[0], r.select[1]);
    });
  };

  return (
    <div className={styles.callBox}>
      <div className="row">
        <label>
          <span title={t('Каждая итерация блока — отдельный запуск этого flow со ссылкой на этот; его итог уходит дальше в {{prev}}')}>{t('Вызвать flow')}</span>
          <select
            value={b.flow || ''}
            onChange={(e) => {
              b.flow = e.target.value;
              markDirty();
            }}
          >
            {!b.flow && <option value="">{t('— выбери flow —')}</option>}
            {b.flow && !callee && <option value={b.flow}>{t('{name} (нет в flows/)', { name: b.flow })}</option>}
            {options.map((f) => (
              <option key={f.name} value={f.name} disabled={f.valid === false}>
                {f.folder ? `${f.folder}/${f.name}` : f.name}{f.valid === false ? ` — ${t('невалиден')}` : ''}
              </option>
            ))}
          </select>
        </label>
        {b.flow && callee && (
          <Link className="btn ghost small" to={`/flow/${encodeURIComponent(b.flow)}`} title={t('Открыть вызываемый flow')}>
            {t('Открыть ↗')}
          </Link>
        )}
      </div>
      {callee?.valid !== false && callee && <div className="muted small">{schemeSummary(callee)}{callee.description ? ` · ${callee.description}` : ''}</div>}
      {b.flow && !callee && flows.length > 0 && <p className="msg err">{t('Flow {name} нет в flows/: сохранить такой вызов нельзя', { name: b.flow })}</p>}
      <div className={styles.pLabel} title={t('Клик вставляет {{переменную}} в задачу. Уже использованные подсвечены')}>{t('Переменные')}</div>
      <div className="chips">
        {vars.map((v) => (
          <button key={v.key} type="button" className={cx('chip', usesVar(text, v.key) && 'on')} title={`{{${v.key}}} — ${v.hint}`} onClick={() => insert(v.key)}>{v.label}</button>
        ))}
      </div>
      <label>
        <span title={t('Станет {{input}} вызываемого flow. Пусто — задача запуска, итог прошлого шага и замечания проверки, если они есть')}>{t('Задача для вызываемого flow')}</span>
        <textarea
          ref={input}
          className={styles.callInput}
          rows={5}
          value={b.input ?? ''}
          placeholder={DEFAULT_CALL_INPUT}
          onChange={(e) => {
            if (e.target.value) b.input = e.target.value;
            else delete b.input;
            markDirty();
          }}
        />
      </label>
    </div>
  );
}

const condKind = (r: EditNextRule): string => r.if?.type ?? 'always';

/** Развилка после блока: правила «если … → блок», «иначе → …»; без правил — следующий блок по порядку. */
export function NextFields({ bi }: { bi: number }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  const rules = nextRules(b);
  const targets = nextTargets(spec, bi);
  const after = spec.blocks[bi + 1];

  const save = (list: EditNextRule[]) => {
    if (list.length) b.next = list;
    else delete b.next;
    markDirty();
  };
  const update = (k: number, patch: Partial<EditNextRule>) => save(rules.map((r, j) => (j === k ? { ...r, ...patch } : r)));
  const setKind = (k: number, kind: string) => {
    const r = rules[k]!;
    if (kind === 'always') update(k, { if: undefined });
    // у судьи развилки своя заготовка рубрики: не «задача выполнена», а «когда идти по правилу»
    else update(k, { if: untilFor(kind, { type: 'none', ...r.if, prompt: r.if?.prompt || NEXT_JUDGE }) });
  };
  const add = () => {
    // новое условное правило — перед «иначе», если оно есть: правило без if — последнее
    const rule: EditNextRule = { if: { type: 'marker', marker: '<DONE>' }, goto: targets[0]!.value };
    const tail = rules.at(-1);
    save(tail && !tail.if ? [...rules.slice(0, -1), rule, tail] : [...rules, rule]);
  };

  return (
    <div className={styles.nextBox}>
      <div className={styles.pLabel} title={t('Проверяется по порядку после блока; первое выполненное правило решает, куда идти. Переход только вперёд: повтор — это цикл блока')}>
        {t('После блока')}
      </div>
      {rules.map((r, k) => {
        const u = r.if;
        return (
          <div key={k} className={styles.nextRule}>
            <select value={condKind(r)} onChange={(e) => setKind(k, e.target.value)} aria-label={t('Условие перехода')}>
              <option value="always">{rules.length > 1 ? t('иначе') : t('всегда')}</option>
              <option value="marker">{t('маркер в выводе')}</option>
              <option value="command">{t('команда вернула 0')}</option>
              <option value="judge">{t('судья сказал «да»')}</option>
            </select>
            {u?.type === 'marker' && (
              <input value={u.marker || ''} placeholder="<BUG>" aria-label={t('Маркер')} onChange={(e) => update(k, { if: { ...u, marker: e.target.value } })} />
            )}
            {u?.type === 'marker' && b.flow === undefined && b.phases.length > 1 && (
              <select
                value={u.phase || ''}
                aria-label={t('В выводе какого этапа')}
                onChange={(e) => {
                  const { phase: _, ...rest } = u;
                  update(k, { if: e.target.value ? { ...rest, phase: e.target.value } : rest });
                }}
              >
                <option value="">{t('последний этап блока')}</option>
                {b.phases.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            )}
            {u?.type === 'command' && (
              <input value={u.run || ''} placeholder="test -f report.md" aria-label={t('Команда')} onChange={(e) => update(k, { if: { ...u, run: e.target.value } })} />
            )}
            {/* «→ блок ✕» переносится целиком: стрелка не остаётся в конце строки условия */}
            <span className={styles.nextGoto}>
              <span className="muted">→</span>
              <select value={r.goto} onChange={(e) => update(k, { goto: e.target.value })} aria-label={t('Куда перейти')}>
                {!targets.some((x) => x.value === r.goto) && <option value={r.goto}>{t('{name} (не ниже этого блока)', { name: r.goto })}</option>}
                {targets.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
              <button type="button" className={cx(styles.icon, styles.danger)} title={t('Убрать правило')} onClick={() => save(rules.filter((_, j) => j !== k))}>✕</button>
            </span>
            {u?.type === 'judge' && (
              <textarea
                className={styles.nextJudge}
                rows={3}
                value={u.prompt || ''}
                aria-label={t('Рубрика судьи')}
                onChange={(e) => update(k, { if: { ...u, prompt: e.target.value } })}
              />
            )}
          </div>
        );
      })}
      <div className={styles.nextFoot}>
        <button type="button" className="btn ghost small" onClick={add}>{t('+ Правило «если …»')}</button>
        <span className="muted small">
          {rules.some((r) => !r.if)
            ? t('правила проверяются сверху вниз')
            : after
              ? t('ни одно не сработало — блок «{block}»', { block: after.title || after.name })
              : t('ни одно не сработало — конец запуска')}
        </span>
      </div>
    </div>
  );
}

/** Блок-вызов в инспекторе вместо чипов этапов: куда ведёт вызов. */
export function CallPaneInfo({ b }: { b: EditBlock }) {
  if (!b.flow) return <p className="muted small">{t('Выбери flow, который вызвать')}</p>;
  return (
    <p className="muted small">
      {t('Этапы — в вызываемом flow')}{' '}
      <Link to={`/flow/${encodeURIComponent(b.flow)}`}>{b.flow}</Link>
    </p>
  );
}
