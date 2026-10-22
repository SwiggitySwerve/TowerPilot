import r11 from '../../e2e/r11-candidate-samples.json' with { type: 'json' };
import { dashboardPagesCase, type DashboardCase } from './dashboardFixture.ts';

export const blueStacksCases = r11.cases.emulator_bluestacks_inventory;
export const blueStacksMixed =
  blueStacksCases.one_stopped_one_running_instance_adb_off_and_a_display_that_is_not_ok;

export function stoppedBlueStacks(): DashboardCase {
  // modified: no recorded case has every instance stopped (before Prepare is needed).
  // Explicitly authorized for unit and browser consent checks; all POST answers stay recorded.
  return {
    ...blueStacksMixed,
    body: {
      ...blueStacksMixed.body,
      running: [],
      suggestion: null,
      instances: blueStacksMixed.body.instances.map((instance) => ({
        ...instance,
        running: false,
      })),
    },
  };
}

export function firstInstallConfig(boundAccount: boolean): DashboardCase {
  const found = dashboardPagesCase(
    boundAccount
      ? 'config_state.populated_accounts_and_loadouts'
      : 'config_state.read_before_the_save',
  );
  const body = found.body as { readonly instances: Readonly<Record<string, object>> };
  // modified: no recorded config case has an empty serial. Same modification as the parent
  // F6M-C-01 unit test, explicitly authorized for browser checks, including a bound account.
  return {
    ...found,
    body: {
      ...body,
      instances: { ...body.instances, main: { ...body.instances['main'], serial: '' } },
    },
  };
}
