import { describe, expect, it } from 'vitest';
import {
  equipmentBody,
  equipmentDraft,
  restoreEligibility,
  restoreModuleRows,
  restoreEquipmentDraft,
} from '../../../src/store/equipmentDraft.ts';
import { own, ownPath } from '../../../src/core/read.ts';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../../../scripts/contract-fixture.mjs';

const cases = own(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture, 'cases');
const body = (family: string, key: string) => ownPath(cases, family, key, 'body');
const profile = body('ability_policies', 'read_before_the_first_save');
describe('restore body owner', () => {
  it('C15-9 r12f malformed saved restore rows keep raw types and extra members when another row changes', () => {
    // Synthetic historical tuple: no recording contains a saved numeric restore slot
    // or extra tuple member. This boundary-only regression proves sibling edits and
    // draft reload never silently repair malformed saved data (not an API response).
    const original = {
      modules_restore: [
        ['first', 42, 'kept extra'],
        ['second', 'assist'],
      ],
    };
    const draft = equipmentDraft(original);
    const rows = restoreModuleRows(draft, original);
    expect(rows[0]?.slot).toBe('42');
    const changed = rows.map((row) =>
      row.key === 'saved:1' ? { ...row, module: 'edited', moduleEdited: true } : row,
    );
    expect(equipmentBody({ ...draft, restoreModules: changed }, original)).toEqual({
      modules_restore: [
        ['first', 42, 'kept extra'],
        ['edited', 'assist'],
      ],
    });
    const restored = restoreEquipmentDraft(
      JSON.parse(JSON.stringify({ ...draft, restoreModules: changed })),
    );
    if (restored === null) throw new Error('Draft provenance was not restored');
    expect(equipmentBody(restored, original)).toEqual(
      equipmentBody({ ...draft, restoreModules: changed }, original),
    );
  });
  it('C15-8 r12f changes restore cards while retaining every untouched manual key', () => {
    const original = ownPath(
      body('loadout_restore', 'read_after_saved_modules_restore'),
      'loadouts',
      'plain',
    );
    const draft = { ...equipmentDraft(original), restoreCards: 'main_farm' };
    expect(equipmentBody(draft, original)).toEqual({
      ...Object(original),
      cards_restore: 'main_farm',
    });
    const placeholder = ownPath(
      body('loadout_restore', 'read_after_saved_modules_restore'),
      'loadouts',
      'later',
    );
    expect(
      equipmentBody({ ...equipmentDraft(placeholder), restoreCards: 'no_card' }, placeholder),
    ).toEqual({ ...Object(placeholder), cards_restore: 'no_card' });
  });
  it('C15-9 preserves ordered raw restore rows and refuses unused changes including clearing', () => {
    const original = ownPath(
      body(
        'loadout_restore_eligibility',
        'read_after_the_clearing_refusal_the_stored_value_remains',
      ),
      'loadouts',
      'spare',
    );
    const draft = { ...equipmentDraft(original), restoreCards: '' };
    // Recorded refused_clearing_the_stored_restore_value_of_a_loadout_no_run_uses:
    // code restore_loadout_unused applies to removal too; never display its message locally.
    expect(restoreEligibility(draft, original, profile, 'spare', 'mine')).toBe('unused');
    expect(restoreEligibility(draft, original, undefined, 'spare', null)).toBe('noProfile');
    expect(restoreEligibility(draft, original, undefined, 'spare', 'mine')).toBeNull();
    expect(
      restoreEligibility(equipmentDraft(original), original, profile, 'spare', 'mine'),
    ).toBeNull();
    const modules = [
      { key: 'a', module: ' unknown ', slot: 'assist' },
      { key: 'b', module: 'second', slot: 'primary' },
    ];
    expect(
      equipmentBody({ ...equipmentDraft(original), restoreModules: modules }, original),
    ).toHaveProperty('modules_restore', [
      [' unknown ', 'assist'],
      ['second', 'primary'],
    ]);
  });
});
