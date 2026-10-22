import { entries, id, list, own, ownPath, text } from '../core/read.ts';

export const EQUIPMENT_FIELDS = [
  'global_preset',
  'cards',
  'module_preset',
  'guardian_preset',
  'workshop_preset',
  'bot_preset',
] as const;
export type EquipmentField = (typeof EQUIPMENT_FIELDS)[number];
export type EquipmentMode = 'manual' | 'global' | 'category';
export interface EquipmentDraft {
  readonly mode: EquipmentMode;
  readonly values: Readonly<Record<EquipmentField, string>>;
}
export const loadoutOf = (body: unknown, name: string): unknown => ownPath(body, 'loadouts', name);
export const configRevision = (body: unknown): string | null =>
  id(own(body, 'config_revision')) ?? null;

export function equipmentMode(body: unknown): EquipmentMode {
  const fields = entries(body);
  if (
    fields.some(([key]) => key !== 'defined' && !EQUIPMENT_FIELDS.some((field) => key === field)) ||
    fields.some(([key, value]) => key !== 'defined' && typeof value !== 'string') ||
    (own(body, 'global_preset') !== undefined && fields.some(([key]) => key !== 'global_preset'))
  )
    return 'manual';
  return typeof own(body, 'global_preset') === 'string' ? 'global' : 'category';
}
export function equipmentDraft(body: unknown): EquipmentDraft {
  return {
    mode: equipmentMode(body),
    values: {
      global_preset: text(own(body, 'global_preset')) ?? '',
      cards: text(own(body, 'cards')) ?? '',
      module_preset: text(own(body, 'module_preset')) ?? '',
      guardian_preset: text(own(body, 'guardian_preset')) ?? '',
      workshop_preset: text(own(body, 'workshop_preset')) ?? '',
      bot_preset: text(own(body, 'bot_preset')) ?? '',
    },
  };
}
export function restoreEquipmentDraft(value: unknown): EquipmentDraft | null {
  const mode = own(value, 'mode');
  const values = own(value, 'values');
  if (
    !['manual', 'global', 'category'].some((candidate) => candidate === mode) ||
    EQUIPMENT_FIELDS.some((field) => typeof own(values, field) !== 'string')
  )
    return null;
  const restored = equipmentDraft(values);
  return {
    ...restored,
    mode: mode === 'manual' ? 'manual' : mode === 'global' ? 'global' : 'category',
  };
}
/** Selection structure only; the backend owns entry behavior and ownership validation. */
export function equipmentBody(
  draft: EquipmentDraft,
  original: unknown,
): Readonly<Record<string, unknown>> {
  if (draft.mode === 'manual') return Object.fromEntries(entries(original));
  return Object.fromEntries(
    EQUIPMENT_FIELDS.flatMap((field) => {
      const active =
        draft.mode === 'global' ? field === 'global_preset' : field !== 'global_preset';
      const value = draft.values[field];
      return active && value !== '' ? [[field, value]] : [];
    }),
  );
}
export function discoveredOptions(source: unknown, field: EquipmentField): readonly string[] {
  const player = ownPath(source, 'profile', 'player');
  const raw =
    field === 'global_preset'
      ? own(player, 'global_presets')
      : field === 'cards'
        ? own(player, 'card_presets')
        : ownPath(
            player,
            'category_presets',
            field === 'module_preset'
              ? 'modules'
              : field === 'guardian_preset'
                ? 'guardians'
                : field === 'workshop_preset'
                  ? 'workshop'
                  : 'bots',
          );
  return [...new Set((list(raw) ?? []).filter((item): item is string => typeof item === 'string'))];
}
export function invalidEquipment(
  draft: EquipmentDraft,
  source: unknown,
): readonly EquipmentField[] {
  return EQUIPMENT_FIELDS.filter((field) => {
    const active =
      draft.mode === 'global'
        ? field === 'global_preset'
        : draft.mode === 'category' && field !== 'global_preset';
    return (
      active &&
      draft.values[field] !== '' &&
      !discoveredOptions(source, field).includes(draft.values[field])
    );
  });
}
