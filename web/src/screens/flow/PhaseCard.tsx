// Карточка этапа (ui/app.js phaseCardHtml + wirePhase): одна разметка в ленте и в редакторе справа (pane). Обе копии
// читают один объект этапа, поэтому правка в одной сразу видна в другой.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchConnectors, useConfig, useFeature } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { useToast } from '../../components/Toast';
import { phaseArtifactAccess } from '../../lib/graph/model';
import { t } from '../../lib/i18n';
import {
  advLabel, duplicatePhase, insertVar, isMulti, movePhase, phaseNum, phaseText, renamePhase, schemaText, slug, usesVar, variableList,
  type EditPhase,
} from '../../lib/flow/edit';
import {
  addConnTools, connChips, connManualError, connNote, connPick, connPicked, CONN_PREFIX, EFFORTS, modelOptions, normalizeConnectors, PERMS, TOOL_HINT,
} from '../../lib/flow/tools';
import { afterRender, dropStaleSel, openPhasePane, showPhasePane } from './actions';
import { DraftInput, DraftTextarea } from './fields';
import { flowState, markDirty, selPhaseAt, useFlowStore } from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Метка параллельной группы рядом с названием этапа. */
export const PGroup = ({ group }: { group?: string }) =>
  group ? <span className={styles.pgroup} title={t('Параллельная группа: соседние этапы с этой группой идут одновременно')}>∥ {group}</span> : null;

export function PhaseCard({ bi, i, pane = false }: { bi: number; i: number; pane?: boolean }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const block = spec.blocks[bi]!;
  const p = block.phases[i]!;
  const config = useConfig().data!;
  const { askConfirm, notify } = useConfirm();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const adv = useRef<HTMLDetailsElement>(null);
  const first = bi === 0 && i === 0;
  const last = bi === spec.blocks.length - 1 && i === block.phases.length - 1;
  const at = selPhaseAt(spec, st.sel);
  const shownInPane = Boolean(at && at.b === bi && at.i === i);
  const aiAdv = Boolean(st.ai?.diff.adv.has(p.name));

  // «Дополнительно» раскрыто в редакторе справа всегда, в ленте — у этапов, где ИИ поменял скрытые там поля
  useEffect(() => {
    if (adv.current && (pane || aiAdv)) adv.current.open = true;
  }, [pane, aiAdv]);

  const text = phaseText(p);
  const vars = variableList(spec, bi, i);

  const insert = (key: string) => {
    const ta = prompt.current!;
    const r = insertVar(ta.value, key, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.selectionStart ?? ta.value.length);
    if (r.text !== p.prompt) {
      p.prompt = r.text;
      markDirty();
    }
    afterRender(() => {
      ta.focus();
      ta.setSelectionRange(r.select[0], r.select[1]);
    });
  };

  const act = async (what: 'up' | 'down' | 'dup' | 'del') => {
    if (what === 'del') {
      if (block.phases.length === 1) {
        await notify(isMulti(spec) ? t('В блоке нужен хотя бы один этап. Чтобы убрать блок целиком, удали его кнопкой ✕ в шапке блока.') : t('Нужен хотя бы один этап'));
        return;
      }
      if (!(await askConfirm(t('Удалить этап «{name}»?', { name: p.title || p.name }), { ok: t('Удалить'), danger: true }))) return;
      // за время вопроса рабочую копию могла заменить правка ИИ или сохранение
      if (flowState.spec !== spec) return;
      block.phases.splice(i, 1);
    }
    if (what === 'up' || what === 'down') {
      const err = movePhase(spec, bi, i, what === 'up');
      if (err) {
        await notify(err);
        return;
      }
    }
    let copyAt = -1;
    if (what === 'dup') copyAt = duplicatePhase(spec, bi, i);
    markDirty();
    dropStaleSel();
    if (copyAt >= 0) openPhasePane(bi, copyAt, styles.flash!);
  };

  // поле карточки слева открывает справа этап целиком; фокус остаётся слева, правки синхронизируются
  const onFocus = () => {
    if (!pane && !shownInPane) showPhasePane(bi, i);
  };

  const set = (patch: Partial<EditPhase>) => {
    Object.assign(p, patch);
    markDirty();
  };

  return (
    <div
      className={cx(styles.pcard, st.ai?.diff.phases.has(p.name) && styles.aiChanged, !pane && shownInPane && styles.paneSrc)}
      id={pane ? undefined : `pcard-${bi}-${i}`}
      data-b={bi}
      data-i={i}
      onFocus={onFocus}
    >
      <div className={styles.pcardHead}>
        <span className={styles.pnum}>{phaseNum(spec, bi, i)}</span>
        <input className={styles.pTitle} data-field="p-title" value={p.title || ''} placeholder={t('Название этапа')} onChange={(e) => set({ title: e.target.value })} />
        <PGroup group={p.group} />
        <button className={styles.icon} title={i === 0 && bi > 0 ? t('В конец предыдущего блока') : t('Выше')} disabled={first} onClick={() => void act('up')}>↑</button>
        <button className={styles.icon} title={i === block.phases.length - 1 && !last ? t('В начало следующего блока') : t('Ниже')} disabled={last} onClick={() => void act('down')}>↓</button>
        <button className={styles.icon} title={t('Дублировать')} onClick={() => void act('dup')}>⧉</button>
        <button className={cx(styles.icon, styles.danger)} title={t('Удалить')} onClick={() => void act('del')}>✕</button>
      </div>
      <div className={cx(styles.pSection, styles.pVars)}>
        <div className={styles.pLabel} title={t('Клик вставляет {{переменную}} в промпт. Уже использованные подсвечены')}>{t('Переменные')}</div>
        <div className="chips">
          {vars.map((v) => (
            <button key={v.key} className={cx('chip', usesVar(text, v.key) && 'on')} title={`{{${v.key}}} — ${v.hint}`} onClick={() => insert(v.key)}>{v.label}</button>
          ))}
        </div>
      </div>
      <label>
        <span title={t('Первое сообщение свежей сессии Claude Code')}>{t('Промпт')}</span>
        <textarea ref={prompt} className={styles.pPrompt} data-field="p-prompt" rows={8} value={p.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} />
      </label>
      <label>
        <span title={t('Чем должен закончиться ответ, чтобы следующий этап мог им пользоваться')}>{t('Что передать следующему этапу')}</span>
        <input className={styles.pHandoff} value={p.handoff || ''} placeholder={t('раздел "## Результат": что сделано, файлы, открытые вопросы')} onChange={(e) => set({ handoff: e.target.value })} />
      </label>
      <ArtifactAccess p={p} />
      <div className={styles.pSection}>
        <div className={styles.pLabel} title={t('Всё выбранное разрешено без подтверждений')}>{t('Инструменты')}</div>
        <div className={cx('chips', styles.tools)}>
          {config.tools.map((t) => (
            <button
              key={t}
              className={cx('chip', styles.toolChip, t === 'AskUserQuestion' && styles.ask, p.tools.includes(t) && cx('on', styles.on))}
              title={TOOL_HINT[t] || ''}
              onClick={() => set({ tools: p.tools.includes(t) ? p.tools.filter((x) => x !== t) : [...p.tools, t] })}
            >
              {t}
            </button>
          ))}
          {config.implicitTools.map((t) => (
            <button key={t} className={cx('chip on', styles.toolChip, styles.on, styles.locked)} disabled title={TOOL_HINT[t] || ''}>{t}</button>
          ))}
        </div>
      </div>
      <div className={cx(styles.pSection, styles.pConn)}>
        <ConnRow p={p} />
      </div>
      <details ref={adv} className={styles.pAdv}>
        <summary>{advLabel(p)}</summary>
        <div className="row">
          <label>
            <span title={t('Идентификатор этапа: на его вывод ссылаются как {{phases.{name}}}', { name: p.name })}>{t('id (для {{phases.id}})')}</span>
            <DraftInput
              className={styles.pName}
              data-field="p-name"
              value={p.name}
              placeholder="slug"
              onCommit={(raw) => {
                const v = slug(raw) || p.name;
                const err = renamePhase(spec, p.name, v);
                if (err) void notify(err);
                else markDirty();
              }}
            />
          </label>
          <label><span>{t('Модель')}</span>
            <select value={p.model || ''} onChange={(e) => set({ model: e.target.value })}>
              {modelOptions(p.model || '').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label><span>Effort</span>
            <select value={p.effort || ''} onChange={(e) => set({ effort: e.target.value })}>
              {EFFORTS.map((e) => <option key={e} value={e}>{e || t('по умолчанию')}</option>)}
            </select>
          </label>
          <label><span>{t('Лимит ходов')}</span><input type="number" min={1} value={String(p.max_turns ?? '')} placeholder="∞" onChange={(e) => set({ max_turns: e.target.value })} /></label>
          <label><span>{t('Права')}</span>
            <select value={p.permission_mode || ''} onChange={(e) => set({ permission_mode: e.target.value })}>
              {PERMS.map((e) => <option key={e} value={e}>{e || t('по умолчанию')}</option>)}
            </select>
          </label>
          <label><span>{t('Лимит стоимости, $')}</span><input type="number" min={0} step="any" value={String(p.max_budget_usd ?? '')} placeholder="—" onChange={(e) => set({ max_budget_usd: e.target.value })} /></label>
          <label>
            <span title={t('Соседние этапы блока с одинаковой группой идут одновременно и видят один {{prev}} — вывод до группы. Следующий этап получает склейку их выводов. В группе от двух этапов, с Edit или Write — не больше одного, без AskUserQuestion')}>{t('Параллельная группа')}</span>
            <DraftInput
              list={`b-groups-${bi}`}
              value={p.group || ''}
              placeholder="—"
              onCommit={(raw) => {
                const v = slug(raw);
                if (v) p.group = v;
                else delete p.group;
                markDirty();
              }}
            />
          </label>
        </div>
        <label>
          <span title={t('Куда этап может ходить, кроме директории проекта: по пути на строку. Например, проект с правилами QA: его CLAUDE.md и скиллы подхватятся')}>{t('Дополнительные директории')}</span>
          <div className="path-field">
            <DraftTextarea
              rows={2}
              placeholder="~/projects/qa-rules"
              value={(p.add_dirs || []).join('\n')}
              onInput={(v) => {
                const dirs = v.split('\n').map((x) => x.trim()).filter(Boolean);
                set({ add_dirs: dirs.length ? dirs : undefined });
              }}
            />
            <PickDirButton
              prompt={t('Выбери дополнительную директорию этапа')}
              start={() => p.add_dirs?.at(-1) ?? ''}
              onPick={(path) => set({ add_dirs: [...(p.add_dirs || []), path] })}
            />
          </div>
        </label>
        <label><span>{t('Системный промпт (пусто = стандартный промпт Claude Code)')}</span><textarea className={styles.pSystem} rows={2} value={p.system || ''} onChange={(e) => set({ system: e.target.value })} /></label>
        <label>
          <span>{t('Схема вывода (JSON Schema): если задана, этап вернёт JSON по ней')}</span>
          <textarea className={styles.pSchema} data-field="p-schema" rows={3} value={schemaText(p)} onChange={(e) => set({ _schemaText: e.target.value })} />
        </label>
      </details>
    </div>
  );
}

/** «Артефакты» строкой: что этап читает и пишет; правится во вкладке YAML. */
function ArtifactAccess({ p }: { p: EditPhase }) {
  const spec = useFlowStore().spec!;
  const on = useFeature('artifacts');
  if (!on || !spec.artifacts || !Object.keys(spec.artifacts).length) return null;
  const { read, write } = phaseArtifactAccess(p);
  const list = (keys: string[]) => keys.map((k, n) => <span key={k}>{n > 0 && ', '}<code>{k}</code></span>);
  const parts = [read.length ? <span key="r">{t('читает')} {list(read)}</span> : null, write.length ? <span key="w">{t('пишет')} {list(write)}</span> : null].filter(Boolean);
  return (
    <div className={styles.pArt} title={t('Чтение — reads и подстановки {{artifacts.KEY}} в промпте и «что передать»; запись — writes, она включает чтение. Без Read, Edit и Write в инструментах этап работает только со своими артефактами. Доступ правится во вкладке YAML')}>
      <span className={styles.pLabel}>{t('Артефакты')}</span>{' '}
      {parts.length ? parts.map((x, n) => <span key={n}>{n > 0 && ' · '}{x}</span>) : <span className="muted">{t('нет доступа')}</span>}
    </div>
  );
}

const CONN_KEY = ['connectors'] as const;

/** Строка «Коннекторы claude.ai» этапа: выданные инструменты, что это значит, выбор новых. Список коннекторов — один на страницу. */
function ConnRow({ p }: { p: EditPhase }) {
  const config = useConfig().data!;
  const can = useFeature('connectors');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: CONN_KEY, queryFn: () => fetchConnectors(false).then(normalizeConnectors), enabled: false, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState('');
  const view = q.data ?? null;
  const builtin = new Set([...config.tools, ...config.implicitTools]);

  const load = (force: boolean) => {
    if (!can || q.isFetching || (!force && q.data)) return;
    void qc.fetchQuery({ queryKey: CONN_KEY, queryFn: () => fetchConnectors(force).then(normalizeConnectors), staleTime: 0 }).catch(() => {});
  };
  const add = (names: string[]) => {
    p.tools = addConnTools(p.tools, names);
    markDirty();
  };
  const addManual = () => {
    const t = manual.trim();
    const err = connManualError(t);
    if (err) {
      toast(err);
      return;
    }
    setManual('');
    add([t]);
  };
  const [tone, note] = connNote(p, builtin, view);

  return (
    <>
      <div className={styles.pLabel} title={t('Коннекторы аккаунта claude.ai приходят в этап, только если их инструменты перечислены здесь. Остальным этапам раннер их выключает: иначе их описания занимают около 45K токенов контекста')}>{t('Коннекторы claude.ai')}</div>
      <div className="chips">
        {connChips(p, builtin, view).map((c) => (
          <span key={c.name} className={cx('chip', styles.connTool, ...c.cls.split(' ').map((k) => k && styles[k]), c.cls.includes('on') && 'on')} title={c.title}>
            {c.text}
            <button type="button" className="attach-x" title={t('Убрать')} onClick={() => { p.tools = p.tools.filter((x) => x !== c.name); markDirty(); }}>×</button>
          </span>
        ))}
        <button
          type="button"
          className={cx('chip', open && 'on')}
          onClick={() => {
            if (!open) load(false);
            setOpen(!open);
          }}
        >
          + Jira, Confluence, Slack…
        </button>
      </div>
      <div className={cx(styles.connNote, tone === 'warn' && styles.warn)}>{note}</div>
      {open && (
        <div className={styles.connPick}>
          {can && (q.isFetching || (!q.data && !q.error)) && <span className="muted small">{t('Загружаю коннекторы аккаунта… (несколько секунд)')}</span>}
          {can && !q.isFetching && q.error && (
            <>
              <span className="msg warn">{t('Список коннекторов не загрузился: {error}', { error: q.error.message })}</span>{' '}
              <button type="button" className="btn small" onClick={() => load(true)}>↻</button>
            </>
          )}
          {can && !q.isFetching && view && <ConnPicker p={p} view={view} onAdd={add} onRefresh={() => load(true)} />}
          <div className={styles.connManual}>
            <input
              className="conn-name"
              placeholder={t('{p}<Коннектор>__<инструмент> или {p}<Коннектор> — весь', { p: CONN_PREFIX })}
              spellCheck={false}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addManual();
                }
              }}
            />
            <button type="button" className="btn small" onClick={addManual}>{t('Добавить')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function ConnPicker({ p, view, onAdd, onRefresh }: { p: EditPhase; view: NonNullable<Parameters<typeof connPick>[1]>; onAdd: (names: string[]) => void; onRefresh: () => void }) {
  const { groups, ready, off } = connPick(p, view);
  return (
    <>
      <div className="row">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onAdd(connPicked(e.target.value, view));
          }}
        >
          <option value="">{ready ? t('— инструмент коннектора —') : t('Подключённых коннекторов нет')}</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => <option key={o.value} value={o.value} title={o.title}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
        <button type="button" className="btn small" title={t('Спросить список заново')} onClick={onRefresh}>↻</button>
      </div>
      {off.length > 0 && <span className="muted small">{t('Не подключены в claude.ai: {list}. Их инструменты появятся после подключения.', { list: off.join(', ') })}</span>}
    </>
  );
}

