// Проверка ссылки на репо по мере ввода (POST /api/teams/check): с паузой после последнего символа, только когда строка
// похожа на ссылку целиком. Общая для формы создания и диалога подключения.
import { useEffect, useState } from 'react';
import type { TeamRemoteCheck } from '@server/api-types';
import { errorText } from '../../api';
import { checkTeamRemote } from '../../api/teamwork';
import { urlLooksComplete } from './shell';

const CHECK_DELAY_MS = 600;

type State = { url: string; check?: TeamRemoteCheck; busy: boolean };

export function useRemoteCheck(url: string): { check: TeamRemoteCheck | undefined; busy: boolean } {
  const [state, setState] = useState<State>({ url: '', busy: false });
  useEffect(() => {
    const u = url.trim();
    if (!urlLooksComplete(u)) {
      setState({ url: u, busy: false });
      return;
    }
    setState((s) => ({ url: u, check: s.url === u ? s.check : undefined, busy: true }));
    const id = setTimeout(() => {
      checkTeamRemote(u).then(
        (check) => setState((s) => (s.url === u ? { url: u, check, busy: false } : s)),
        (err: unknown) => setState((s) => (s.url === u ? { url: u, check: { kind: 'error', error: errorText(err) }, busy: false } : s)),
      );
    }, CHECK_DELAY_MS);
    return () => clearTimeout(id);
  }, [url]);
  const same = state.url === url.trim();
  return { check: same ? state.check : undefined, busy: same && state.busy };
}
