import { useId, useLayoutEffect, useRef } from 'react';
import type { CopyEntry, CopyText } from '../../../copy/text.ts';
import { copy } from '../../../copy/catalogue.ts';
import { lastRead } from '../../../copy/dashboard/shell.ts';
import { selectTopBarVM } from '../../../store/selectors/topBar.ts';
import { Button } from '../../../ui/Button.tsx';
import { Chip } from '../../../ui/Chip.tsx';
import { pageHref } from '../../../ui/routes.ts';
import { ServerValue } from '../../../ui/ServerValue.tsx';
import { TopBarAccount } from '../TopBarAccount.tsx';
import { useDashboard, useView } from '../context.ts';
import './topBar.css';

const words = copy.dashboard.topBar;
const connectionLines: Readonly<Record<string, CopyEntry>> = words.connection;

/** Region 0: identity, adb connection and navigation (F-001 to F-005). */
export function TopBar({
  title,
  readOnly = false,
}: {
  readonly title: CopyText;
  readonly readOnly?: boolean;
}) {
  const vm = useView(selectTopBarVM);
  const { commands } = useDashboard();
  const menu = useRef<HTMLDetailsElement>(null);
  const reconnectSlot = useRef<HTMLSpanElement>(null);
  const focusedReconnect = useRef<HTMLElement | null>(null);
  const reasonId = useId();
  useLayoutEffect(() => {
    const previous = focusedReconnect.current;
    if (previous === null || previous.isConnected) return;
    focusedReconnect.current = null;
    // A read can replace the focused link with a command, or the command with a link.
    reconnectSlot.current?.querySelector<HTMLElement>('a[href], button')?.focus();
  }, [vm.reconnectAction, readOnly]);
  const connectionLine = connectionLines[vm.connection.line];
  const reason =
    vm.reconnect.reason === 'process_listed'
      ? words.reconnectReasons.process_listed
      : vm.reconnect.reason === 'sending'
        ? words.reconnectReasons.sending
        : words.reconnectReasons.process_list_unavailable;
  return (
    <div className="tp-topbar__row tp-topbar-content">
      <span className="tp-brand">{copy.app.name.short}</span>
      <h1 className="tp-topbar__page">{title}</h1>
      <div className="tp-topbar-identity">
        <span className="tp-topbar-account">
          <TopBarAccount vm={vm} />
          {vm.accountLastKnown && vm.accountAgeSec !== null ? (
            <span className="tp-topbar-meta">{lastRead(vm.accountAgeSec)}</span>
          ) : null}
          <a href="#profiles">{words.accountDetails.short}</a>
        </span>
        <span>
          {vm.emulator.kind === 'known' ? (
            <ServerValue value={vm.emulator.value} kind="name" label={words.emulator.short} />
          ) : (
            words.emulatorUnknown.short
          )}
        </span>
        <span className="tp-topbar-connection">
          {vm.connection.word === null && vm.connection.line === 'connected' ? (
            <Chip state="running" label={words.connection.connected.short} />
          ) : (
            <>
              {vm.connection.word === null ? null : <Chip state={vm.connection.word} />}
              <span>{connectionLine?.short ?? words.connection.connection_unconfirmed.short}</span>
            </>
          )}
        </span>
        {readOnly ? null : (
          <span
            className="tp-topbar-reconnect"
            ref={reconnectSlot}
            onFocusCapture={(event) => {
              focusedReconnect.current = event.target;
            }}
            onBlurCapture={(event) => {
              if (
                event.target.isConnected &&
                (!(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget))
              ) {
                focusedReconnect.current = null;
              }
            }}
          >
            {vm.reconnectAction === 'choose_emulator' ? (
              <a href={pageHref('emulators')}>{words.chooseEmulator.short}</a>
            ) : (
              <>
                <Button
                  tier="secondary"
                  label={words.reconnect.short}
                  onClick={() => {
                    if (vm.reconnect.command !== null)
                      void commands.reconnect(vm.reconnect.command);
                  }}
                  busy={vm.reconnect.sending}
                  {...(vm.reconnect.enabled ? {} : { disabled: true, reasonId })}
                />
                {vm.reconnect.enabled ? null : <span id={reasonId}>{reason.short}</span>}
              </>
            )}
          </span>
        )}
      </div>
      <details className="tp-pages" ref={menu}>
        <summary>{words.pages.short}</summary>
        <nav aria-label={words.pages.short}>
          <ul>
            {words.appPages.map((page) => (
              <li key={page.id}>
                <a
                  href={pageHref(page.id)}
                  onClick={() => {
                    if (menu.current !== null) menu.current.open = false;
                  }}
                >
                  {page.label.short}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </details>
      <div className="tp-topbar-extra">
        {vm.connection.word === null ? null : (
          <details className="tp-topbar-why">
            <summary>{copy.common.why.short}</summary>
            <p>
              {vm.connectionAgeSec === null ? words.notRead.short : lastRead(vm.connectionAgeSec)}
            </p>
          </details>
        )}
        {vm.emulator.kind === 'unknown' && vm.emulatorInstance !== null ? (
          <details className="tp-topbar-details">
            <summary>{words.details.short}</summary>
            <ServerValue value={vm.emulatorInstance} kind="id" label={words.instance.short} />
          </details>
        ) : null}
      </div>
    </div>
  );
}
