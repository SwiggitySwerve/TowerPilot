import { MATRIX as SPEC_MATRIX } from './specData.ts';

// The clear-HUD fixture adds a Waiting row after the historical spec snapshot.
// Its two aliased ids also move the later collector samples' Stop targets.
// Redo these remaps whenever the fixture regenerates with a new sample before them.
const STOP_TARGETS: Readonly<Record<string, string>> = {
  worker_not_running: '00000027@2',
  worker_unverified: '00000028@2',
  working_collector_claims_failing: '00000029@2',
  working_collector_finder_suspected: '0000002b@2',
};
export const MATRIX = [
  ...SPEC_MATRIX.map((row) => ({
    ...row,
    stopTargets: STOP_TARGETS[row.sample] ?? row.stopTargets,
  })),
  {
    sample: 'waiting_for_clear_battle',
    pause: 'shown',
    turnInputOff: 'shown',
    stopTargets: '00000025@2',
    gem: 'Waiting',
    input: 'Unknown',
    automation: 'Running',
  },
].sort((a, b) => a.sample.localeCompare(b.sample));
