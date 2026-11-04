// «Загружаю…» экранов сессий: появляется, только если ответа нет дольше LOADING_DELAY_MS — быстрый ответ не мигает.
import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n';

const LOADING_DELAY_MS = 300;

export function Loading({ className }: { className?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), LOADING_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  // область role=status — сразу, текст — потом: экранный чтец объявляет изменение уже стоящей области
  return <p className={`muted ${className ?? ''}`} role="status">{shown ? t('Загружаю…') : ''}</p>;
}
