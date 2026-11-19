// Колонка доски: заголовок с числом (у «В работе» и «Готово» — точка статуса), карточки и место, куда бросают
// перетаскиваемую карточку.
import { useId, useState, type ReactNode } from 'react';
import type { DeskColumn as Column } from '@server/desk/types';
import type { BoardColumn } from '../../../lib/desk-board';
import styles from './Desk.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

export function DeskColumn({ col, dragging, onDrop, children }: {
  col: BoardColumn;
  /** Ключ перетаскиваемой карточки; нет — ничего не тащат. */
  dragging: string | undefined;
  onDrop: (key: string, to: Column) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  // своё на каждую доску: две доски на странице не делят id заголовков
  const id = `${useId()}-col`;
  return (
    <section
      className={cx(styles.col, over && dragging && styles.over)}
      data-desk-column={col.column}
      aria-labelledby={id}
      onDragOver={(e) => {
        if (!dragging || !e.dataTransfer.types.includes('text/x-desk-key')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // уход на дочерний элемент — не уход из колонки
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const key = e.dataTransfer.getData('text/x-desk-key');
        if (!key) return;
        e.preventDefault();
        onDrop(key, col.column);
      }}
    >
      <h3 className={styles.colH} id={id} tabIndex={-1}>
        {(col.column === 'work' || col.column === 'done') && <span className={cx(styles.colDot, styles[col.column])} aria-hidden="true" />}
        <span>{col.title}</span>
        <span className={styles.colN}>{col.countText}</span>
      </h3>
      {col.items.length ? <ul className={styles.cards} aria-labelledby={id}>{children}</ul> : <p className={styles.empty}>{col.empty}</p>}
    </section>
  );
}
