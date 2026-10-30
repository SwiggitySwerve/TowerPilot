import type { CopyNode, CopyText } from '../copy/text.ts';
import { Disclosure } from './Disclosure.tsx';
import './ui.css';

/** How many items a long list shows before the rest fold away (council-tiles synthesis). */
export const SHOWN_LIMIT = 10;

interface ShownListBase<T> {
  readonly items: readonly T[];
  /** A stable key per item (it survives polls). */
  readonly itemKey: (item: T) => string;
  readonly render: (item: T) => CopyNode;
  /** Feature hook classes, kept beside `tp-shown` on both lists. */
  readonly className?: string;
  /** `list` stacks the items; `grid` lays them out as many columns as fit (default list). */
  readonly layout?: 'list' | 'grid';
}

/** A long list folds after `limit` items (default 10); `limit="all"` shows every item and has no fold. */
export type ShownListProps<T> = ShownListBase<T> &
  (
    | {
        /** The disclosure's label; its count is how many items it holds. */
        readonly more: CopyText;
        /** How many items show before the disclosure (default 10). */
        readonly limit?: number;
        /** A stable key for the disclosure's summary (F-113). */
        readonly focusKey?: string;
      }
    | { readonly limit: 'all'; readonly more?: undefined; readonly focusKey?: undefined }
  );

/**
 * A bounded list: the first `limit` items, then the rest behind one Disclosure
 * with their count. Every item stays in the document, so find-in-page and the
 * Disclosure's native open state keep working; nothing pages or scrolls away.
 * `limit="all"` is for a list a person must see whole (a grid of every choice).
 */
export function ShownList<T>(props: ShownListProps<T>) {
  const { items, itemKey, render, className, layout = 'list' } = props;
  const base = layout === 'grid' ? 'tp-shown tp-shown--grid' : 'tp-shown';
  const list = className === undefined ? base : `${base} ${className}`;
  const cut =
    props.limit === 'all' ? items.length : Math.max(0, Math.floor(props.limit ?? SHOWN_LIMIT));
  const shown = items.slice(0, cut);
  const rest = items.slice(cut);
  const draw = (part: readonly T[]) => (
    <ul className={list}>
      {part.map((item) => (
        <li key={itemKey(item)}>{render(item)}</li>
      ))}
    </ul>
  );
  return (
    <div className="tp-shown-list">
      {shown.length === 0 ? null : draw(shown)}
      {rest.length === 0 || props.more === undefined ? null : (
        <Disclosure
          label={props.more}
          count={rest.length}
          {...(props.focusKey === undefined ? {} : { focusKey: props.focusKey })}
        >
          {draw(rest)}
        </Disclosure>
      )}
    </div>
  );
}
