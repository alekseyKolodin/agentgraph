// Раздел 2 «Что сделать» (Editor.dc.html): flow (список с поиском), папка, задача для flow с «что именно придёт»,
// «Запускать: сразу / после моего «да» / сразу, но стоп перед блоком» и свёрнутое «Дополнительно» со сводкой одной
// строкой (пространство, рабочее дерево, лимиты, модель). Рутина, которая только заводит дела, flow не выбирает.
// В «Новой рутине» под flow ещё «Собрать новый flow…», «Только завести дело» и готовый flow шаблона (FlowExtras).
import { useState } from 'react';
import type { RoutineMode } from '@server/routines/types';
import { useFeature, useFlows } from '../../../api';
import { useSpaces } from '../../../api/spaces';
import { Chips, ctlClass, Field, ModelSelect, NumberField, Select, Seg, TextArea, type SelectOption } from '../../../components/form';
import { SpacePicker } from '../../../components/SpacePicker';
import { plural, t } from '../../../lib/i18n';
import { extrasSummary } from '../../../lib/routines/editor';
import { draftMissing, draftRuns, isSchedule } from '../../../lib/routines/spec';
import { CwdField } from '../CwdField';
import { FlowInput } from '../EventSample';
import { cx, useFlowBlocks } from '../parts';
import { Section, type DraftProps, type FilledProp, type RoutineSource } from './Section';

/** Что добавляет к выбору flow «Новая рутина». */
export type FlowExtras = {
  /** Готовый flow шаблона, которого у человека ещё нет: скопируется при сохранении. */
  tplFlow?: { name: string; description?: string };
  /** «Собрать новый flow…»: черновик сохраняется, по возврате новый flow подставится сам. */
  onBuildFlow?: () => void;
  /** Подсказка под полем: «подставил flow, который ты только что собрал». */
  note?: string;
};
import s from './Sections.module.css';

/** Раздел «Что сделать» целиком. */
export function WhatSection({ d, set, src, filled, extras }: DraftProps & FilledProp & { src: RoutineSource; extras?: FlowExtras }) {
  const runs = draftRuns(d);
  const missing = draftMissing(d);
  const [inputOpen, setInputOpen] = useState(false);
  const event = !isSchedule(d) && src.source;
  return (
    <Section n={2} title={t('Что сделать')} sub={t('что запускается на событие')} filled={filled}>
      <div className={cx(s.card, s.fields)}>
        <div className={s.grid2}>
          <FlowField d={d} set={set} extras={extras} />
          {runs && (
            <Field label={t('Папка')} help={t('Пусто — папка пространства или папка по умолчанию')}>
              <CwdField value={d.cwd} onChange={(cwd) => set({ cwd })} worktree={d.worktree} />
            </Field>
          )}
        </div>
        {runs && (
          <Field
            label={t('Задача для flow')}
            help={t('Пусто — задача из самого flow')}
            hint={
              event ? (
                <>
                  {t('Событие flow получит сам: заголовок, автора, ссылку, текст и поля.')}{' '}
                  <button type="button" className={s.link} aria-expanded={inputOpen} onClick={() => setInputOpen(!inputOpen)}>
                    {inputOpen ? t('Скрыть') : t('Что именно придёт')}
                  </button>
                </>
              ) : undefined
            }
          >
            <TextArea rows={2} placeholder={t('Например: сделай ревью MR и оставь замечания')} value={d.input} onChange={(e) => set({ input: e.target.value })} />
          </Field>
        )}
        {runs && inputOpen && event && <FlowInput key={event.slug} source={event} kind={src.kind} sample={src.sample} task={d.input} />}
        {runs && <RunModeField d={d} set={set} missingBlock={missing.includes('block')} />}
        {runs && (
          <>
            <div className={s.hr} />
            <Extras d={d} set={set} />
          </>
        )}
      </div>
    </Section>
  );
}

/** Flow: список с поиском; у рутины с делом из события можно «ничего — только завести дело». */
export function FlowField({ d, set, extras }: DraftProps & { extras?: FlowExtras }) {
  const flows = useFlows();
  const list = (flows.data ?? []).filter((f) => f.valid);
  const taskOnly = d.taskOn && d.taskFrom === 'event';
  // готовый flow шаблона, которого у человека ещё нет: в списке с пометкой, копия появится при сохранении
  const tpl = extras?.tplFlow && !list.some((f) => f.name === extras.tplFlow!.name) ? extras.tplFlow : undefined;
  const options: SelectOption<string>[] = [
    ...(taskOnly ? [{ value: '', label: t('ничего — только завести дело') }] : []),
    ...(tpl ? [{ value: tpl.name, label: tpl.name, sub: t('готовый, из шаблона') }] : []),
    ...list.map((f) => ({ value: f.name, label: f.name, sub: f.description, keywords: f.folder })),
    ...(d.flow && d.flow !== tpl?.name && !list.some((f) => f.name === d.flow) ? [{ value: d.flow, label: d.flow, sub: flows.isPending ? undefined : t('не найден') }] : []),
  ];
  const blocks = list.find((f) => f.name === d.flow)?.blocks?.length ?? 0;
  return (
    <div className={s.col}>
      <Field label="Flow" issue={draftMissing(d).includes('flow') ? { tone: 'warn', text: t('Выбери flow') } : undefined} hint={extras?.note}>
        <Select<string>
          searchable
          mono
          value={d.flow}
          options={options}
          placeholder={flows.isPending ? t('Загрузка…') : t('выбери flow')}
          renderValue={(o) =>
            o ? (
              <>
                {o.label}
                {tpl && o.value === tpl.name && <span className={s.meta}> · {t('готовый, из шаблона')}</span>}
                {blocks > 1 && <span className={s.meta}> · {t('{n} {w}', { n: blocks, w: plural(blocks, 'блок', 'блока', 'блоков') })}</span>}
              </>
            ) : (
              d.flow || t('выбери flow')
            )
          }
          onChange={(flow) => set({ flow, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}
        />
      </Field>
      {extras && (
        <div className={s.btns}>
          {extras.onBuildFlow && (
            <button type="button" className="btn small ghost" title={t('Описать задачу словами — ИИ соберёт flow. Черновик рутины сохранится: вернёшься — новый flow подставится сам')} onClick={extras.onBuildFlow}>
              {t('Собрать новый flow…')}
            </button>
          )}
          {!taskOnly && (
            <button
              type="button"
              className="btn small ghost"
              title={t('Без flow: событие станет делом в «Моих делах», и всё')}
              // вид дела — данные правила, не текст интерфейса
              onClick={() => set({ flow: '', taskOn: true, taskFrom: 'event', taskKind: d.taskKind || 'Задача', taskClose: d.taskClose || 'thing', mode: 'auto', pauseBefore: [] })}
            >
              {t('Только завести дело')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * «Запускать»: сразу (auto), после моего «да» (suggest — событие ждёт на главной), сразу, но стоп перед блоком
 * (until_pause, блоки чипами). У flow из одного блока стоп перед блоком — то же, что «после моего «да»».
 */
export function RunModeField({ d, set, missingBlock }: DraftProps & { missingBlock: boolean }) {
  const blocks = useFlowBlocks(d.flow);
  const canGate = blocks.length > 1 || d.pauseBefore.length > 0;
  // перед первым блоком — то же, что «после моего «да»»: его не предлагаем, но уже выбранное не прячем
  const gates = [...new Set([...blocks.slice(1), ...d.pauseBefore])];
  return (
    <Field label={t('Запускать')} issue={missingBlock ? { tone: 'warn', text: t('Выбери блок, перед которым остановиться') } : undefined}>
      <Seg<RoutineMode>
        value={d.mode}
        onChange={(mode) => set({ mode, ...(mode === 'until_pause' && !d.pauseBefore.length && blocks[1] ? { pauseBefore: [blocks[1]] } : {}) })}
        options={[
          { value: 'auto', label: t('сразу'), title: t('Запустится сам и пройдёт до конца без остановок') },
          { value: 'suggest', label: t('после моего «да»'), title: t('Событие появится на главной; запуск начнётся после твоего «Запустить»') },
          { value: 'until_pause', label: t('сразу, но стоп перед блоком'), disabled: !canGate, title: canGate ? t('Запустится сам и остановится перед выбранными блоками') : t('У этого flow один блок: остановка перед ним — то же, что «после моего «да»»') },
        ]}
      />
      {/* почему «стоп перед блоком» выключен — словами под выбором, не только в подсказке */}
      {blocks.length === 1 && !d.pauseBefore.length && <span className={s.meta}>{t('«Стоп перед блоком» — для flow из нескольких блоков; у этого один, остановка перед ним — «после моего «да»».')}</span>}
      {d.mode === 'until_pause' && gates.length > 0 && <Chips<string> label={t('Перед какими блоками остановиться')} value={d.pauseBefore} options={gates.map((b) => ({ value: b, label: b }))} onChange={(pauseBefore) => set({ pauseBefore })} />}
    </Field>
  );
}

const numOf = (v: string): number | null => {
  const n = Number(v.trim().replace(',', '.').replace(/^\$/, ''));
  return v.trim() && Number.isFinite(n) ? n : null;
};
const strOf = (n: number | null): string => (n === null ? '' : String(n));

/** «Дополнительно ›»: свёрнуто — сводка одной строкой; развёрнуто — пространство, рабочее дерево, лимиты, модель flow. */
export function Extras({ d, set }: DraftProps) {
  const [open, setOpen] = useState(false);
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn && open);
  return (
    <>
      <button type="button" className={s.more} aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>{open ? t('Дополнительно ⌄') : t('Дополнительно ›')}</b>
        {!open && <span className={s.moreSum}>{extrasSummary(d, { spaces: spacesOn })}</span>}
      </button>
      {open && (
        <div className={s.grid2}>
          {spacesOn && (
            <SpacePicker
              id="routine-edit-space"
              value={d.space}
              onChange={(space) => set({ space })}
              options={spaces.data?.spaces ?? []}
              loading={spaces.isPending}
              placeholder={t('без пространства')}
              inputClassName={ctlClass({})}
            />
          )}
          <Field label={t('Рабочее дерево')} help={t('Новое дерево — на каждое событие своя копия репозитория на новой ветке (git worktree): твои файлы и текущая ветка не трогаются. Нужна корневая папка репозитория')}>
            <Seg<'none' | 'new'>
              value={d.worktree}
              onChange={(worktree) => set({ worktree })}
              options={[
                { value: 'none', label: t('та же папка') },
                { value: 'new', label: t('новое дерево') },
              ]}
            />
          </Field>
          <Field label={t('Бюджет на запуск')} hint={t('Запуск остановится, когда потратит столько')}>
            <NumberField prefix="$" suffix={t('не больше')} placeholder={t('без лимита')} min={0.01} value={numOf(d.usd)} format={(n) => n.toFixed(2)} onChange={(n) => set({ usd: strOf(n) })} />
          </Field>
          <Field label={t('Запусков в день')}>
            <NumberField integer min={1} placeholder={t('без лимита')} value={numOf(d.perDay)} onChange={(n) => set({ perDay: strOf(n) })} />
          </Field>
          <Field label={t('Одновременно')} help={t('Сколько запусков рутины могут идти разом')}>
            <NumberField integer min={1} placeholder={t('без лимита')} value={numOf(d.parallel)} onChange={(n) => set({ parallel: strOf(n) })} />
          </Field>
          <Field label={t('Модель flow')} help={t('«Как в flow» — каждый этап на своей модели. Своя модель заменяет её во всех этапах запусков этой рутины')}>
            <ModelSelect value={d.model} defaultLabel={t('как в flow')} onChange={(model) => set({ model })} />
          </Field>
        </div>
      )}
    </>
  );
}
