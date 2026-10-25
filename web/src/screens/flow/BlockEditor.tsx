// Блок в конструкторе (ui/app.js blockHtml, blockHeadHtml, blockPanelHtml, wireBlock): шапка с названием и порядком
// (несколько блоков), цикл и условие остановки, теги знаний; в ленте — ещё этапы блока, в инспекторе — чипы этапов.
import { useFeature } from '../../api';
import { TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  blockHeading, blockLabel, isMulti, moveBlock, newPhase, phaseNum, setBlockMode, slug, TAG_SLUG_RE, untilFor, type EditBlock,
} from '../../lib/flow/edit';
import { plural } from '../../lib/format';
import { bindField, dropStaleSel, openPhasePane, sameField } from './actions';
import { DraftInput } from './fields';
import { PhaseCard } from './PhaseCard';
import { emit, flowState, knowledgeDraft, markDirty, useFlowStore, type BlockField, type FieldKey } from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const iterWordFor = (n: number) => `${n} ${plural(n, 'итерацию', 'итерации', 'итераций')}`;

/** Чип тега знаний: как у запуска (tagBadge с видом knowledge). */
export const KnowledgeBadge = ({ slug: t }: { slug: string }) => <TagBadge slug={t} kind="knowledge" />;

/** Поле блока в ленте открывается в крупном редакторе справа (режим «поле»); в инспекторе — нет. */
function useBlockField(b: EditBlock, bi: number, inPane: boolean) {
  const st = useFlowStore();
  return (key: BlockField) => {
    const field: FieldKey = { scope: 'block', block: b, b: bi, key };
    const on = !inPane && st.sel?.kind === 'field' && sameField(st.sel.field, field);
    return {
      className: on ? styles.focusedSrc : undefined,
      onFocus: inPane ? undefined : () => bindField(field),
    };
  };
}

/** Шапка блока (несколько блоков): номер, название, ↑ ↓ ✕. */
export function BlockHead({ bi, inPane = false }: { bi: number; inPane?: boolean }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  const { askConfirm, notify } = useConfirm();
  const field = useBlockField(b, bi, inPane)('title');
  if (!isMulti(spec)) return null;
  const act = async (what: 'up' | 'down' | 'del') => {
    if (what === 'del') {
      if (spec.blocks.length === 1) {
        await notify('Нужен хотя бы один блок');
        return;
      }
      if (!(await askConfirm(`Удалить блок «${blockLabel(b, bi)}» вместе с этапами (${b.phases.length})?`, { ok: 'Удалить', danger: true }))) return;
      // за время вопроса рабочую копию могла заменить правка ИИ или сохранение
      if (flowState.spec !== spec) return;
      spec.blocks.splice(bi, 1);
    } else moveBlock(spec, bi, what === 'up');
    markDirty();
    dropStaleSel();
  };
  return (
    <div className={styles.bblockHead}>
      <span className={styles.bnum}>Блок {bi + 1}</span>
      <input
        className={cx(styles.bTitle, field.className)}
        value={b.title || ''}
        placeholder="Название блока"
        onFocus={field.onFocus}
        onChange={(e) => {
          b.title = e.target.value;
          markDirty();
        }}
      />
      <button className={styles.icon} title="Блок выше" disabled={bi === 0} onClick={() => void act('up')}>↑</button>
      <button className={styles.icon} title="Блок ниже" disabled={bi === spec.blocks.length - 1} onClick={() => void act('down')}>↓</button>
      <button className={cx(styles.icon, styles.danger)} title="Удалить блок" onClick={() => void act('del')}>✕</button>
    </div>
  );
}

/** Цикл блока: режим, условие остановки, что делать при провале, теги знаний. */
export function BlockPanel({ bi, inPane = false }: { bi: number; inPane?: boolean }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  const multi = isMulti(spec);
  const loop = b.loop;
  const u = loop?.until;
  const kinds = useFeature('tag-kinds');
  const { notify } = useConfirm();
  const field = useBlockField(b, bi, inPane);
  const dirty = () => markDirty();

  const addKnowledge = () => {
    const t = (knowledgeDraft.get(b) || '').trim();
    if (!t) return;
    if (!TAG_SLUG_RE.test(t)) {
      void notify('Слаг тега: строчные латинские буквы, цифры и дефис');
      return;
    }
    knowledgeDraft.set(b, '');
    if ((b.knowledge || []).includes(t)) {
      emit();
      return;
    }
    b.knowledge = [...(b.knowledge || []), t];
    markDirty();
  };
  const fk = field('knowledge');

  return (
    <div className={cx('panel', styles.bpanel)} data-bpanel={bi}>
      <h3>{multi ? 'Как выполнять блок' : 'Цикл'}</h3>
      <div className="row">
        {multi && (
          <label style={{ maxWidth: 200 }}>
            <span title="Идентификатор блока: ключ в YAML и в отчётах запуска">id блока</span>
            <DraftInput
              className={styles.bName}
              value={b.name}
              placeholder="slug"
              onCommit={(raw) => {
                const v = slug(raw) || b.name;
                if (v !== b.name && spec.blocks.some((x) => x.name === v)) {
                  void notify(`Блок ${v} уже есть`);
                  return;
                }
                b.name = v;
                dirty();
              }}
            />
          </label>
        )}
        <label style={{ maxWidth: 200 }}>
          <span>Режим</span>
          <select
            value={loop ? 'loop' : 'once'}
            onChange={(e) => {
              setBlockMode(b, e.target.value === 'loop');
              dirty();
            }}
          >
            <option value="loop">цикл до условия</option>
            <option value="once">один проход</option>
          </select>
        </label>
        {loop && u && (
          <>
            <label style={{ maxWidth: 140 }}>
              <span>Лимит итераций</span>
              <DraftInput
                type="number"
                min={1}
                max={50}
                value={String(loop.max_iterations)}
                onInput={(v) => {
                  loop.max_iterations = Number(v) || 1;
                  dirty();
                }}
              />
            </label>
            <label>
              <span title="Проверяется после всех этапов блока">Условие остановки</span>
              <select
                value={u.type}
                onChange={(e) => {
                  loop.until = untilFor(e.target.value, u);
                  dirty();
                }}
              >
                <option value="command">команда завершилась с кодом 0</option>
                <option value="judge">LLM-судья сказал «готово»</option>
                <option value="marker">в выводе этапа есть маркер</option>
                <option value="none">без условия, ровно N итераций</option>
              </select>
            </label>
          </>
        )}
      </div>
      {u?.type === 'command' && (
        <div className="row">
          <label>
            <span>Команда (её вывод уйдёт в {'{{feedback}}'})</span>
            <input
              {...field('until-run')}
              value={u.run || ''}
              placeholder="npm test"
              onChange={(e) => {
                u.run = e.target.value;
                dirty();
              }}
            />
          </label>
          <label style={{ maxWidth: 160 }}>
            <span>Таймаут, с</span>
            <DraftInput
              type="number"
              min={1}
              value={String(u.timeout_sec ?? '')}
              placeholder="600"
              onInput={(v) => {
                const n = Number(v);
                if (n > 0) u.timeout_sec = n;
                else delete u.timeout_sec;
                dirty();
              }}
            />
          </label>
        </div>
      )}
      {u?.type === 'judge' && (
        <label>
          <span title="Судья видит {{input}} и {{outputs}} и отвечает: готово или нет, и замечания">Рубрика судьи</span>
          <textarea
            {...field('until-prompt')}
            className={cx(styles.bUntilPrompt, field('until-prompt').className)}
            rows={5}
            value={u.prompt || ''}
            onChange={(e) => {
              u.prompt = e.target.value;
              dirty();
            }}
          />
        </label>
      )}
      {u?.type === 'marker' && (
        <div className="row">
          <label>
            <span>Маркер</span>
            <input
              {...field('until-marker')}
              value={u.marker || ''}
              placeholder="<DONE>"
              onChange={(e) => {
                u.marker = e.target.value;
                dirty();
              }}
            />
          </label>
          <label>
            <span>В выводе какого этапа</span>
            <select
              value={u.phase || ''}
              onChange={(e) => {
                if (e.target.value) u.phase = e.target.value;
                else delete u.phase;
                dirty();
              }}
            >
              <option value="">последний этап блока</option>
              {b.phases.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {multi && loop && u && u.type !== 'none' && (
        <label>
          <span>Если условие не выполнено за {iterWordFor(loop.max_iterations)}</span>
          <select
            value={b.on_fail === 'continue' ? 'continue' : 'stop'}
            onChange={(e) => {
              if (e.target.value === 'continue') b.on_fail = 'continue';
              else delete b.on_fail;
              dirty();
            }}
          >
            <option value="stop">остановить запуск</option>
            <option value="continue">всё равно перейти к следующему блоку</option>
          </select>
        </label>
      )}
      {kinds && (
        <div className={styles.bKnowledgeBox}>
          <label>
            <span title="Теги вида «знание» со страницы «Теги»: их заметки, пути и вложения получат все этапы блока. Несуществующий тег роняет запуск до старта">Теги знаний</span>
            <input
              className={fk.className}
              onFocus={fk.onFocus}
              list="knowledge-tag-list"
              placeholder="выбери из списка или впиши слаг и нажми Enter: qa"
              autoComplete="off"
              spellCheck={false}
              value={knowledgeDraft.get(b) || ''}
              onChange={(e) => {
                knowledgeDraft.set(b, e.target.value);
                emit();
              }}
              onBlur={addKnowledge}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addKnowledge();
                }
              }}
            />
          </label>
          <div className="chips">
            {(b.knowledge || []).map((t) => (
              <span key={t} className="chip attach-chip">
                <KnowledgeBadge slug={t} />
                <button
                  type="button"
                  className="attach-x"
                  title="Убрать тег у блока"
                  onClick={() => {
                    const rest = (b.knowledge || []).filter((x) => x !== t);
                    if (rest.length) b.knowledge = rest;
                    else delete b.knowledge;
                    dirty();
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Блок в ленте: шапка, цикл, этапы, «Добавить этап». */
export function BlockSection({ bi }: { bi: number }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  const multi = isMulti(spec);
  const groups = [...new Set(b.phases.map((p) => p.group).filter(Boolean))] as string[];
  return (
    <section className={cx(styles.bblock, multi && styles.multi, st.ai?.diff.blocks.has(b.name) && styles.aiChanged)} data-b={bi} id={`bblock-${bi}`}>
      <BlockHead bi={bi} />
      <BlockPanel bi={bi} />
      <h3>Этапы{multi ? ` блока ${bi + 1}` : ''}</h3>
      <datalist id={`b-groups-${bi}`}>
        {groups.map((g) => <option key={g} value={g} />)}
      </datalist>
      <div>
        {b.phases.map((p, i) => <PhaseCard key={phaseKey(p)} bi={bi} i={i} />)}
      </div>
      <button
        className="btn"
        onClick={() => {
          b.phases.push(newPhase(spec, bi));
          markDirty();
          openPhasePane(bi, b.phases.length - 1, styles.flash!);
        }}
      >
        Добавить этап
      </button>
    </section>
  );
}

/** Блок в инспекторе: шапка, цикл и чипы этапов блока. */
export function BlockPane({ bi }: { bi: number }) {
  const st = useFlowStore();
  const spec = st.spec!;
  const b = spec.blocks[bi]!;
  return (
    <section className={cx(styles.bblock, styles.paneBlock)} data-b={bi}>
      <BlockHead bi={bi} inPane />
      <BlockPanel bi={bi} inPane />
      <div className={styles.panePhases}>
        <div className={styles.pLabel}>Этапы блока</div>
        <div className="chips">
          {b.phases.map((p, i) => (
            <button key={phaseKey(p)} type="button" className="chip" onClick={() => openPhasePane(bi, i, styles.flash!)}>
              {phaseNum(spec, bi, i)} {p.title || p.name}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Заголовки инспектора для блока: контекст и что открыто. */
export const blockPaneTitles = (spec: NonNullable<ReturnType<typeof useFlowStore>['spec']>, bi: number) => {
  const b = spec.blocks[bi]!;
  return { ctx: isMulti(spec) ? blockHeading(b, bi) : 'Flow', label: b.loop ? 'Цикл и условие остановки' : 'Блок: один проход' };
};

// ключ карточки — сам объект этапа: после ↑/↓ React переставляет карточки, а не переписывает поля чужих этапов
const ids = new WeakMap<object, number>();
let idSeq = 0;
export function phaseKey(o: object): number {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = ++idSeq));
  return id;
}
