import type { CopyEntry, CopyText } from '../../../copy/text.ts';
import { copy } from '../../../copy/catalogue.ts';
import { lastRead } from '../../../copy/dashboard/shell.ts';
import { selectTopBarVM } from '../../../store/selectors/topBar.ts';
import { Chip } from '../../../ui/Chip.tsx';
import type { PageId } from '../../../ui/routes.ts';
import { ServerValue } from '../../../ui/ServerValue.tsx';
import { TopBarAccount } from '../TopBarAccount.tsx';
import { useView } from '../context.ts';
import { ReconnectControl } from './ReconnectControl.tsx';
import { HeaderInputControl } from './HeaderInputControl.tsx';
import './topBar.css';

const words = copy.dashboard.topBar;
const connectionLines: Readonly<Record<string, CopyEntry>> = words.connection;

/** Page identity, account/emulator context and scoped connection recovery. */
export function TopBar({
  title,
  pageId = 'dashboard',
  readOnly = false,
}: {
  readonly title: CopyText;
  readonly pageId?: PageId;
  readonly readOnly?: boolean;
}) {
  const vm = useView(selectTopBarVM);
  const connectionLine = connectionLines[vm.connection.line];
  return (
    <div className="tp-topbar__row tp-topbar-content">
      <h1 className="tp-topbar__page">{title}</h1>
      <div className="tp-topbar-identity">
        <span className="tp-topbar-account">
          <TopBarAccount vm={vm} />
          {vm.accountLastKnown && vm.accountAgeSec !== null ? (
            <span className="tp-topbar-meta">{lastRead(vm.accountAgeSec)}</span>
          ) : null}
          <a href="#profiles">{words.accountDetails.short}</a>
        </span>
        <div className="tp-topbar-emulator">
          {vm.emulator.kind === 'known' ? (
            <ServerValue value={vm.emulator.value} kind="name" label={words.emulator.short} />
          ) : (
            words.emulatorUnknown.short
          )}
          {vm.emulator.kind === 'unknown' && vm.emulatorInstance !== null ? (
            <details className="tp-topbar-details">
              <summary>{words.details.short}</summary>
              <ServerValue value={vm.emulatorInstance} kind="id" label={words.instance.short} />
            </details>
          ) : null}
        </div>
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
        {readOnly ? null : <ReconnectControl vm={vm} readOnly={readOnly} />}
      </div>
      <div className="tp-topbar-extra">
        {vm.connection.word === null ? null : (
          <details className="tp-topbar-why">
            <summary>{copy.common.why.short}</summary>
            <p>
              {vm.connectionAgeSec === null ? words.notRead.short : lastRead(vm.connectionAgeSec)}
            </p>
          </details>
        )}
      </div>
      {pageId === 'dashboard' ? null : <HeaderInputControl />}
    </div>
  );
}
