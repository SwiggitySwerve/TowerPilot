import { useEffect, useRef } from 'react';
import { history as t } from '../../copy/history.ts';
import type { CopyText } from '../../copy/text.ts';
import type { HistoryRead, HistoryStore } from '../../store/history.ts';
import { selectHistory, type HistoryRowVM } from '../../store/selectors/history.ts';
import { useStoreSelector, viewEqual } from '../../store/store.ts';
import { ServerValue } from '../../ui/ServerValue.tsx';
import { useAnnounce } from '../../ui/LiveRegion.tsx';
import { TopBar } from '../dashboard/topBar/TopBar.tsx';
import { HistoryDetail, HistoryText } from './HistoryDetail.tsx';
import './history.css';

function focusAnchor(heading: HTMLHeadingElement | null) {
  heading?.focus();
  if (window.innerWidth <= 760) heading?.scrollIntoView({ block: 'start' });
}

function ReadState({ read, reading }: { readonly read: HistoryRead; readonly reading: CopyText }) {
  return (
    <div className="tp-history__read">
      {read.busy ? <p>{reading}</p> : null}
      {read.error === null ? null : (
        <p className="tp-history__notice">
          {t.errors[read.error].short} {t.unavailable.short}
        </p>
      )}
      {read.loadedAt === null ? null : (
        <p className="tp-history__note">
          <time>{t.loaded(read.loadedAt)}</time>
        </p>
      )}
    </div>
  );
}

function RecordRow({
  row,
  selected,
  onSelect,
}: {
  readonly row: HistoryRowVM;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="tp-history__record"
        aria-pressed={selected}
        disabled={row.id === null}
        onClick={onSelect}
      >
        <span className="tp-history__record-name">
          {row.name === null ? t.unnamed.short : <ServerValue kind="name" value={row.name} />}
        </span>
        <span>
          <HistoryText value={row.status} />
        </span>
        <span>
          {t.blueprint.short}
          {t.separator.short}
          {row.blueprint === null ? (
            t.unknown.short
          ) : (
            <ServerValue kind="id" value={row.blueprint} />
          )}
        </span>
        <span className="tp-history__row-metrics">
          <span>
            {t.tier.short}
            {t.separator.short}
            {t.number(row.tier)}
          </span>
          <span>
            {t.observedWave.short}
            {t.separator.short}
            {t.number(row.observedWave)}
          </span>
          <span>
            {t.finalWave.short}
            {t.separator.short}
            {t.number(row.finalWave)}
          </span>
        </span>
        <span>
          {t.start.short}
          {t.separator.short}
          {t.time(row.startedAt)}
        </span>
        <span className="tp-history__note">
          {row.recordId === null ? t.unknown.short : <ServerValue kind="id" value={row.recordId} />}
        </span>
      </button>
    </li>
  );
}

/** H1–H4: list/detail inspector. Its only actions are scoped GET reads and local selection. */
export function HistoryPage({ history }: { readonly history: HistoryStore }) {
  const vm = useStoreSelector(history, selectHistory, viewEqual);
  const records = useRef<HTMLHeadingElement>(null);
  const detail = useRef<HTMLHeadingElement>(null);
  const focusDetail = useRef(false);
  const announce = useAnnounce();
  useEffect(() => {
    if (focusDetail.current && vm.selected !== null) {
      focusAnchor(detail.current);
      focusDetail.current = false;
    }
  }, [vm.selected]);
  useEffect(() => {
    // Completing a read may reveal enough content to scroll the anchor to the top.
    // Respect any focus move the person made while waiting, especially Back to records.
    if (
      vm.detailRead.loadedAt !== null &&
      document.activeElement === detail.current &&
      window.innerWidth <= 760
    )
      detail.current?.scrollIntoView({ block: 'start' });
  }, [vm.detailRead.loadedAt]);
  useEffect(() => {
    if (vm.list.error !== null) announce(t.errors[vm.list.error].short);
    else if (vm.list.loadedAt !== null) announce(t.recordsLoaded.short);
  }, [announce, vm.list.error, vm.list.loadedAt]);
  useEffect(() => {
    if (vm.detailRead.error !== null) announce(t.errors[vm.detailRead.error].short);
  }, [announce, vm.detailRead.error]);
  return (
    <>
      <header className="tp-topbar">
        <TopBar pageId="history" title={t.pageName.short} readOnly />
      </header>
      <main id="main" className="tp-main tp-history" tabIndex={-1}>
        <p className="tp-history__note">{t.introduction.short}</p>
        {!vm.targetKnown ? <p>{t.targetUnknown.short}</p> : null}
        <div className="tp-history__toolbar">
          <label>
            <span>{t.filter.short}</span>
            <select
              value={vm.filter}
              onChange={(event) => {
                const filter = event.currentTarget.value;
                if (
                  filter === 'all' ||
                  filter === 'active' ||
                  filter === 'prepared' ||
                  filter === 'ended' ||
                  filter === 'interrupted'
                )
                  history.filter(filter);
              }}
            >
              {Object.entries(t.filters).map(([value, label]) => (
                <option key={value} value={value}>
                  {label.short}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={history.refreshList}
            aria-disabled={vm.list.busy || !vm.targetKnown}
          >
            {vm.list.error === null ? t.refresh.short : t.retry.short}
          </button>
          <nav aria-label={t.paging.short}>
            <button
              type="button"
              disabled={!vm.hasPrevious || vm.list.busy}
              onClick={() => {
                history.page('previous');
              }}
            >
              {t.previous.short}
            </button>
            <span>{t.page(vm.pageNumber)}</span>
            <button
              type="button"
              disabled={!vm.hasNext || vm.list.busy}
              onClick={() => {
                history.page('next');
              }}
            >
              {t.next.short}
            </button>
          </nav>
        </div>
        <p className="tp-history__note">{t.noTotal.short}</p>
        <div className="tp-history__columns">
          <section className="tp-history__panel" aria-labelledby="history-records">
            <h2 id="history-records" tabIndex={-1} ref={records}>
              {t.records.short}
            </h2>
            <ReadState read={vm.list} reading={t.reading.short} />
            {vm.list.loadedAt !== null && vm.rows.length === 0 ? <p>{t.empty.short}</p> : null}
            <ul className="tp-history__records">
              {vm.rows.map((row, index) => (
                <RecordRow
                  key={row.id ?? index}
                  row={row}
                  selected={row.id === vm.selected}
                  onSelect={() => {
                    if (row.id !== null) {
                      if (row.id === vm.selected) focusAnchor(detail.current);
                      else {
                        focusDetail.current = true;
                        history.select(row.id);
                      }
                    }
                  }}
                />
              ))}
            </ul>
          </section>
          <section className="tp-history__panel" aria-labelledby="history-detail">
            <h2 id="history-detail" tabIndex={-1} ref={detail}>
              {t.detail.short}
            </h2>
            <div className="tp-history__detail-actions">
              <button
                type="button"
                onClick={() => {
                  focusDetail.current = false;
                  focusAnchor(records.current);
                }}
              >
                {t.back.short}
              </button>
              <button
                type="button"
                aria-disabled={vm.selected === null || vm.detailRead.busy}
                onClick={history.refreshDetail}
              >
                {vm.detailRead.error === null ? t.detailRefresh.short : t.detailRetry.short}
              </button>
            </div>
            <ReadState read={vm.detailRead} reading={t.readingDetail.short} />
            {vm.selected === null ? <p>{t.choose.short}</p> : null}
            {vm.detail === null ? null : (
              <HistoryDetail key={vm.selected} vm={vm.detail} onOlder={history.loadOlder} />
            )}
          </section>
        </div>
      </main>
    </>
  );
}
