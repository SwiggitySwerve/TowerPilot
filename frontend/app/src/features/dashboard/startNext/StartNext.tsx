import { useId } from 'react';
import { recognitionHref } from '../../../core/recognition.ts';
import { copy } from '../../../copy/catalogue.ts';
import type { CopyText } from '../../../copy/text.ts';
import { selectStartNext, type StartNextVM } from '../../../store/selectors/startNext.ts';
import { Button } from '../../../ui/Button.tsx';
import { Chip } from '../../../ui/Chip.tsx';
import { Disclosure } from '../../../ui/Disclosure.tsx';
import { RegionBody } from '../../../ui/Region.tsx';
import { ServerOption, ServerValue } from '../../../ui/ServerValue.tsx';
import { useDashboard, useView } from '../context.ts';
import { DashboardRegion } from '../shared/DashboardRegion.tsx';
import './startNext.css';

const words = copy.dashboard.startNext;

function readinessText(line: StartNextVM['readiness']['line'], count: number): CopyText {
  return line === 'images_missing' ? words.imagesMissing(count) : words.readiness[line].short;
}

function reasonText(reason: StartNextVM['reasons'][number]): CopyText {
  if (
    (reason.code === 'guard_blocks' || reason.code === 'guard_unconfirmed') &&
    reason.guardCode === 'setup_battle_unresolved'
  )
    return words.reasons.setup_battle_unresolved.short;
  switch (reason.code) {
    case 'pick_run':
    case 'sending':
    case 'input_off':
    case 'connection_blocked':
    case 'guard_blocks':
    case 'pick_single_run':
    case 'preview_unavailable':
    case 'context_changed':
    case 'gem_routines_off':
    case 'ownership_unconfirmed':
    case 'automation_listed':
      return words.reasons[reason.code].short;
    default:
      return words.reasons.guard_unconfirmed.short;
  }
}

function ReadinessDetails({ details }: { readonly details: StartNextVM['readiness']['details'] }) {
  return (
    <ul>
      {details.map((detail, index) => (
        <li key={index}>
          <ServerValue
            value={detail.value}
            kind="message"
            {...(detail.kind === 'setting' ? { label: words.setting.short } : {})}
          />
        </li>
      ))}
    </ul>
  );
}

function StartNextBody() {
  const vm = useView(selectStartNext);
  const { commands } = useDashboard();
  const id = useId();
  const startReasonId = `${id}-start-reason`;
  const collectReasonId = `${id}-collect-reason`;
  const startPermitted = vm.start.enabled;
  return (
    <RegionBody>
      <div className="tp-start-next">
        <div className="tp-start-next__controls">
          <label className="tp-start-next__picker" htmlFor={`${id}-run`}>
            <span>{words.picker.short}</span>
            <select
              id={`${id}-run`}
              value={vm.picker.selected ?? ''}
              data-focus-key="startNext:run"
              onChange={(event) => {
                commands.selectRun(event.currentTarget.value);
              }}
            >
              {vm.picker.runs.length === 0 ? <option value="">{words.empty.short}</option> : null}
              {vm.picker.runs.map((run) =>
                run.label === null ? (
                  <option key={run.name} value={run.name}>
                    {words.unnamedRun.short}
                  </option>
                ) : (
                  <ServerOption key={run.name} value={run.name} label={run.label} />
                ),
              )}
            </select>
          </label>
          <Button
            tier="primary"
            label={words.start.short}
            focusKey="startNext:start"
            busy={vm.start.sending}
            {...(startPermitted ? {} : { disabled: true, reasonId: startReasonId })}
            onClick={() => {
              if (vm.start.command !== null) void commands.start(vm.start.command);
            }}
          />
          <Button
            tier="secondary"
            label={words.collect.short}
            focusKey="startNext:collect"
            busy={vm.collect.sending}
            {...(vm.collect.enabled ? {} : { disabled: true, reasonId: collectReasonId })}
            onClick={() => {
              if (vm.collect.command !== null) void commands.collect(vm.collect.command);
            }}
          />
        </div>
        {vm.reasons.map((reason) => (
          <div key={reason.action} className="tp-start-next__reason">
            <p
              id={reason.action === 'start' ? startReasonId : collectReasonId}
              data-guard-code={reason.guardCode ?? reason.code}
            >
              <span>
                {reason.action === 'start' ? words.startReason.short : words.collectReason.short}
              </span>
              {words.space}
              <Chip state="blocked" />
              {words.space}
              <span>{reasonText(reason)}</span>
            </p>
            {reason.message === null ? null : (
              <Disclosure label={copy.common.why.short} focusKey={`startNext:${reason.action}:why`}>
                <ServerValue value={reason.message} kind="message" />
              </Disclosure>
            )}
          </div>
        ))}
        <div className="tp-start-next__readiness">
          {/* "Ready" only while Start is permitted: never beside a Blocked line. */}
          {vm.readiness.line === 'ready' && !startPermitted ? null : (
            <p data-readiness={vm.readiness.line}>
              {vm.readiness.line === 'readiness_check_failed' ||
              vm.readiness.line === 'readiness_unknown' ? (
                <Chip state="unknown" />
              ) : null}
              <span>{readinessText(vm.readiness.line, vm.readiness.imageCount)}</span>
            </p>
          )}
          {vm.readiness.line === 'not_ready' ? (
            <ReadinessDetails details={vm.readiness.details} />
          ) : vm.readiness.details.length > 0 ? (
            <Disclosure label={copy.common.why.short} focusKey="startNext:readiness:why">
              <ReadinessDetails details={vm.readiness.details} />
            </Disclosure>
          ) : null}
          {vm.readiness.imageCount > 0 ? (
            <a href={recognitionHref(vm.picker.selected)} data-focus-key="startNext:learn">
              {words.learn.short}
            </a>
          ) : null}
        </div>
        {vm.transferHint === null ? null : <p>{words.transfer[vm.transferHint].short}</p>}
        <a href={recognitionHref(vm.picker.selected)} data-focus-key="startNext:prepare">
          {words.prepare.short}
        </a>
      </div>
    </RegionBody>
  );
}

/** Region 'startNext' (spec 2.1): owned by its region author. */
export function StartNext() {
  return (
    <DashboardRegion id="startNext">
      <StartNextBody />
    </DashboardRegion>
  );
}
