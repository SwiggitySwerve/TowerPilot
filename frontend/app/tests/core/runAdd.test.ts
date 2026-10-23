import { describe, expect, it } from 'vitest';
import {
  runAddAnswer,
  runAddOptions,
  runAddRecorded,
  runIdCheck,
  runRecipes,
} from '../../src/core/runAdd.ts';
import { own, ownPath } from '../../src/core/read.ts';
import { dashboardPagesCase, dashboardPagesCaseNames } from '../support/dashboardFixture.ts';

const sample = (name: string) => dashboardPagesCase(`run_templates_add.${name}`);
const fenced = (name: string) => dashboardPagesCase(`run_templates_add_fenced.${name}`);
const recipes = runRecipes(sample('read_the_recipes_the_page_offers').body);

describe('RL4 recipe rules', () => {
  it.each(['', ' ', 'two', 'NaN', 'Infinity', '1.5'])(
    'RL4 an explicitly entered invalid tier %j stays invalid instead of selecting a default',
    (raw) => {
      const farm = recipes.find((recipe) => recipe.id === 'farm');
      if (farm === undefined) throw new Error('missing farm recipe');
      expect(runAddOptions(farm, { label: 'A run', tier: raw })).toBeNull();
      expect(runAddOptions(farm, { label: 'A run' })).toEqual({ label: 'A run' });
    },
  );
  it('RL4 offers exactly the recorded recipes and their optional policies and kind choices', () => {
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      'farm',
      'tournament',
      'shard',
      'dissonance',
    ]);
    expect(recipes.find((recipe) => recipe.id === 'shard')?.fields).toEqual([
      'label',
      'tier',
      'loadout',
      'count',
    ]);
    expect(recipes.find((recipe) => recipe.id === 'dissonance')?.fields).toContain('perk_bans');
  });

  it.each(
    dashboardPagesCaseNames('run_templates_add').filter((name) => name.startsWith('run_id_')),
  )('RL4 locally refuses the recorded id: %s', (name) => {
    const runId = own(sample(name).request.body, 'run_id');
    if (typeof runId !== 'string') return;
    expect(runIdCheck(runId, sample('read_before_the_first_add').body)).not.toBeNull();
  });

  it.each(['tournament', 'shard', 'dissonance'])(
    'RL4 %s requires an explicit account equipment choice and a label',
    (name) => {
      const recipe = recipes.find((item) => item.id === name);
      if (recipe === undefined) throw new Error('missing recorded recipe');
      expect(runAddOptions(recipe, { label: 'A run' })).toBeNull();
      expect(runAddOptions(recipe, { loadout: 'plain' })).toBeNull();
      expect(runAddOptions(recipe, { label: 'A run', loadout: 'plain' })).toEqual({
        label: 'A run',
        loadout: 'plain',
      });
    },
  );

  it.each(
    dashboardPagesCaseNames('run_templates_add').filter((name) => sample(name).status === 400),
  )('RL4 recorded 400 class %s is refused except a failure after writing', (name) => {
    expect(runAddAnswer(sample(name), { blueprint: 'new_run', preset: 'coin' })).toBe(
      name === 'written_then_the_answer_failed' || name === 'body_not_json_400'
        ? 'unconfirmed'
        : 'refused',
    );
  });

  it.each(
    dashboardPagesCaseNames('run_templates_add_fenced').filter(
      (name) => fenced(name).request.method === 'POST',
    ),
  )('RL4 guarded answer %s follows its recorded outcome', (name) => {
    const entry = fenced(name);
    const body = entry.request.body;
    const blueprint = own(body, 'run_id');
    const kind = ownPath(
      entry.body,
      'profile',
      'blueprints',
      typeof blueprint === 'string' ? blueprint : '',
      'kind',
    );
    expect(
      runAddAnswer(entry, {
        blueprint: typeof blueprint === 'string' ? blueprint : 'new_run',
        preset: typeof kind === 'string' ? kind : 'coin',
      }),
    ).toBe(
      entry.status === 200
        ? 'confirmed'
        : name === 'written_then_the_answer_failed' || name === 'body_not_json_400'
          ? 'unconfirmed'
          : 'refused',
    );
  });

  it('RL4 a read must hold the sent run with its recipe kind; absence and wrong kind keep Unknown', () => {
    expect(
      runAddRecorded(fenced('read_before_the_first_add').body, {
        blueprint: 'lost_run',
        preset: 'coin',
      }),
    ).toBe(false);
    expect(
      runAddRecorded(fenced('read_settles_the_lost_answer_the_run_is_there_once').body, {
        blueprint: 'lost_run',
        preset: 'coin',
      }),
    ).toBe(true);
    expect(
      runAddRecorded(fenced('read_settles_the_lost_answer_the_run_is_there_once').body, {
        blueprint: 'lost_run',
        preset: 'shard',
      }),
    ).toBe(false);
  });
});
