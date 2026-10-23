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

export function editingFilesFailed(state: DashboardState) {
  const read = state.reads.profileFiles.latest;
  return read !== null && (read.outcome.kind === 'failed' || read.outcome.status !== 200);
}

/** A failed selection read must not expose an older successful source as current evidence. */
export function editingSourceError(state: DashboardState) {
  const target = selectEditingTarget(state);
  const read = state.reads[target.inactive ? 'targetSource' : 'profileSource'].latest;
  if (
    target.inactive &&
    (read?.targetSelection?.name !== target.name ||
      read.targetSelection.generation !== target.generation)
  )
    return null;
  const body = read?.outcome.body;
  return fromServer('message', own(body, 'error'));
}

/** Editors use evidence for their selection; journal settlement independently uses the raw read. */
export function editorSource(state: DashboardState): ReadRecord | null {
  const target = selectEditingTarget(state);
  if (target.blocked !== null || target.name === null) return null;
  const read = state.reads[target.inactive ? 'targetSource' : 'profileSource'].latest;
  if (
    target.inactive &&
    (read?.targetSelection?.name !== target.name ||
      read.targetSelection.generation !== target.generation)
  )
    return null;
  return read?.outcome.kind === 'answered' &&
    read.outcome.status === 200 &&
    own(read.outcome.body, 'name') === target.name
    ? read
    : null;
}
