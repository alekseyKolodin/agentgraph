// Текущее время, обновляется раз в period: подписи «N мин назад» и живые таймеры без перезапроса данных.
import { useEffect, useState } from 'react';

export function useNow(period: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(timer);
  }, [period]);
  return now;
}
