// Переходы к flow (ui/app.js openFlow, openDraft, leaveDraft): подтверждения про черновик, идущую правку ИИ и несохранённый
// конструктор, загрузка flow и раскрытие его папки в сайдбаре. Уход с экрана flow по ссылкам и «назад» ловит FlowScreen (useBlocker).
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { errorText, fetchFlow, keys, moveFlow, type FlowGenerated } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { reveal, setOpen } from '../../components/shell/fold';
import { t } from '../../lib/i18n';
import { closeFlow, flowState, openLoaded, set, type Tab } from './store';

type Ask = ReturnType<typeof useConfirm>['askConfirm'];

export const DIRTY_TEXT = t('Есть несохранённые изменения в конструкторе. Перейти без сохранения?');

/**
 * Уход с черновика разового запуска: он пропадёт, спрашиваем. false — остаёмся. close: false — черновик закроет сам вызывающий
 * после перехода (иначе экран черновика успеет увести на главную раньше, чем переход случится).
 */
export async function leaveDraft(ask: Ask, close = true): Promise<boolean> {
  if (!flowState.flow?.draft) return true;
  if (!(await ask(t('Черновик разового запуска не запущен и не сохранён: он пропадёт. Уйти?'), { ok: t('Уйти'), danger: true }))) return false;
  if (close) closeFlow();
  return true;
}

/** Папка flow в сайдбаре — раскрыта, раздел Flow — тоже. */
export const revealFlow = (folder: string | undefined) => reveal('sec:flows', folder ? `folder:${folder}` : null);

/** Открыть flow: подтверждения, загрузка, переход на /flow/<имя>. По умолчанию — вкладка «Запуск», как в старом UI. */
export function useOpenFlow() {
  const navigate = useNavigate();
  const { askConfirm, notify } = useConfirm();
  return useCallback(async (name: string, tab: Tab = 'run', state?: unknown): Promise<boolean> => {
    // черновик закрывает openLoaded новым flow: закрытый раньше увёл бы экран черновика на главную, пока грузится flow
    if (!(await leaveDraft(askConfirm, false))) return false;
    const draft = Boolean(flowState.flow?.draft);
    if (flowState.aiAbort && !(await askConfirm(t('ИИ ещё правит flow. Прервать правку и перейти?'), { ok: t('Прервать') }))) return false;
    if (!draft && flowState.dirty && !(await askConfirm(DIRTY_TEXT, { ok: t('Перейти') }))) return false;
    let doc;
    try {
      doc = await fetchFlow(name);
    } catch (err) {
      // уйти с черновика согласились: он пропадает и при ошибке, как в старом
      if (draft) closeFlow();
      await notify(errorText(err));
      return false;
    }
    // переход подтверждён до подмены flow: экран черновика, увидев обычный flow, не уводит на главную
    flowState.approved = true;
    openLoaded(doc, tab);
    revealFlow(doc.folder);
    void navigate(`/flow/${name}`, { state });
    return true;
  }, [navigate, askConfirm, notify]);
}

/** Открыть черновик разового запуска (ответ генерации без сохранения): конструктор, в flows/ ничего нет. */
export function useOpenDraft() {
  const navigate = useNavigate();
  const { askConfirm } = useConfirm();
  return useCallback(async (r: FlowGenerated): Promise<boolean> => {
    if (!(await leaveDraft(askConfirm, false))) return false;
    if (!flowState.flow?.draft && flowState.dirty && !(await askConfirm(DIRTY_TEXT, { ok: t('Перейти') }))) return false;
    flowState.approved = true;
    openLoaded({ name: r.name, yaml: r.yaml, summary: r.summary, spec: r.spec, folder: '', draft: true }, 'builder');
    void navigate('/draft');
    return true;
  }, [navigate, askConfirm]);
}

/** Перенести flow в папку (перетаскивание в сайдбаре, поле папки в шапке): '' — корень flows/. */
export function useMoveFlow() {
  const qc = useQueryClient();
  const { notify } = useConfirm();
  return useCallback(async (name: string, folder: string, current: string): Promise<void> => {
    if (current === folder) return;
    try {
      const r = await moveFlow(name, folder);
      if (flowState.flow?.name === name && !flowState.flow.draft) set({ flow: { ...flowState.flow, folder: r.folder } });
      if (r.folder) setOpen(`folder:${r.folder}`, true);
      await qc.invalidateQueries({ queryKey: keys.flows });
    } catch (err) {
      await notify(errorText(err));
    }
  }, [qc, notify]);
}
