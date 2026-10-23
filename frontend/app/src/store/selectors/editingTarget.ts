import {
  editingTarget,
  editTargetKey,
  pickableProfiles,
  type EditingTarget,
} from '../../core/editingTarget.ts';
import { profileFilesView } from '../../core/profiles.ts';
import { own } from '../../core/read.ts';
import { fromServer } from '../../copy/server.ts';
import type { DashboardState, ReadRecord } from '../types.ts';

/** Only the latest successful read grants listing evidence, never a retained older answer. */
export function editingFiles(state: DashboardState) {
  const read = state.reads.profileFiles.latest;
  return read?.outcome.kind === 'answered' && read.outcome.status === 200
    ? profileFilesView(read.outcome.body)
    : null;
}

export function selectEditingTarget(state: DashboardState): EditingTarget {
  const pick = state.context === null ? undefined : state.editTargets[editTargetKey(state.context)];
  return {
    ...editingTarget(state.context, pick, editingFiles(state)),
    generation: state.editTargetGeneration,
  };
}

export function editingTargetVM(target: EditingTarget) {
  return {
    ...target,
    name: fromServer('name', target.name),
    active: fromServer('name', target.active),
  };
}

export function selectEditingChoices(state: DashboardState) {
  return pickableProfiles(editingFiles(state)).map((file) => ({
    key: file.name,
    name: fromServer('name', file.name),
  }));
}

/** Editors receive a full source read, only when its body names this exact usable target. */
export function editorSource(state: DashboardState): ReadRecord | null {
  const target = selectEditingTarget(state);
  if (target.blocked !== null || target.name === null) return null;
  const read = state.reads[target.inactive ? 'targetSource' : 'profileSource'].latest;
  return read?.outcome.kind === 'answered' &&
    read.outcome.status === 200 &&
    own(read.outcome.body, 'name') === target.name
    ? read
    : null;
}
