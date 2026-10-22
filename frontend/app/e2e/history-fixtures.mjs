// @ts-check
import { loadHistoryFixture } from '../scripts/history-fixture.mjs';
import { record } from '../scripts/generate-contract.mjs';

const cases = loadHistoryFixture();

/** Every returned answer originates in the backend-generated pages fixture.
 * @param {'history_list' | 'history_detail'} family @param {string} name
 */
export function historyCase(family, name) {
  const row = record(record(cases[family])[name]);
  if (typeof row['status'] !== 'number')
    throw new Error(`Unknown history fixture ${family}.${name}`);
  return { status: row['status'], body: structuredClone(record(row['body'])) };
}

/** Unique real-route records, with evidence variants first, for the 20+1 paging browser flow. */
export const HISTORY_DETAIL_NAMES = [
  'collection_sampled_confirmations_ended',
  'setup_verified',
  'setup_degraded_module_not_equipped',
  'stats_capture_unverified_wrong_tier',
  'stats_capture_verified',
  'active_adopted_partial_observation',
  'interrupted_before_any_observation_everything_unknown',
  'ended_after_an_observation_gap',
  'prepared_nothing_observed',
  ...Object.keys(record(cases['history_detail'])),
].filter((name, index, all) => all.indexOf(name) === index);

const seen = new Set();
export const HISTORY_RECORDS = HISTORY_DETAIL_NAMES.flatMap((name) => {
  const answer = historyCase('history_detail', name);
  const battle = record(answer.body['battle'] ?? {});
  const id = battle['id'];
  if (
    answer.status !== 200 ||
    typeof id !== 'string' ||
    seen.has(id) ||
    record(answer.body['context'])['account'] !== null
  )
    return [];
  seen.add(id);
  return [{ name, battle }];
});

/** Paging/filtering slices actual generated records; no invented battle or evidence fields.
 * @param {URL} url @param {string | undefined} selected
 */
export function historyAnswer(url, selected) {
  if (url.pathname === '/api/battles') {
    if (selected?.startsWith('list:')) return historyCase('history_list', selected.slice(5));
    const template = historyCase('history_list', 'first_page');
    const status = url.searchParams.get('status');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 21);
    template.body['battles'] = HISTORY_RECORDS.map((row) => row.battle)
      .filter((battle) => !status || battle['status'] === status)
      .slice(offset, offset + limit);
    return template;
  }
  if (selected !== undefined && !selected.startsWith('list:'))
    return historyCase('history_detail', selected);
  const id = decodeURIComponent(url.pathname.slice('/api/battles/'.length));
  const row = HISTORY_RECORDS.find((row) => row.battle['id'] === id);
  return historyCase('history_detail', row?.name ?? 'unknown_record_404');
}
