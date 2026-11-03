/**
 * The hash of each page of the new app and of a target on it (`#runs/live`,
 * `#runs/saved/<run>`): one definition, used by app/router.ts to match and by
 * features to link (features may not import app/).
 */
export const PAGE_IDS = [
  'dashboard',
  'runs',
  'history',
  'schedule',
  'equipment',
  'profiles',
  'abilities',
  'collection',
  'emulators',
  'runtime',
  'recognition',
] as const;

export type PageId = (typeof PAGE_IDS)[number];

/** Pages reachable by address only: the navigation does not list them (`#gallery`, the item gallery). */
export const HIDDEN_PAGE_IDS = ['gallery'] as const;

export type HiddenPageId = (typeof HIDDEN_PAGE_IDS)[number];

/** The sections of one run's saved settings, each shown on its own (`#runs/saved/<run>/entry`). */
export const SAVED_SECTIONS = ['routines', 'queue', 'entry'] as const;

export type SavedSection = (typeof SAVED_SECTIONS)[number];

/**
 * Where a page opens: the Runs page's live editor, one run's saved settings (and which of
 * its sections) or its shared shopping policies, or one gathering policy of the Collection page.
 */
export type PageTarget =
  | { readonly kind: 'live' }
  | { readonly kind: 'library' }
  | { readonly kind: 'saved'; readonly run: string; readonly section?: SavedSection }
  | { readonly kind: 'policy'; readonly policy: string }
  | {
      readonly kind: 'ability';
      readonly family: 'uw_policies' | 'rescue_policies';
      readonly policy: string;
    };

export function pageHref(id: PageId, target: PageTarget | null = null): `#${string}` {
  if (target === null) return `#${id}`;
  switch (target.kind) {
    case 'ability':
      return `#${id}/${target.family}/${encodeURIComponent(target.policy)}`;
    case 'live':
      return `#${id}/live`;
    case 'library':
      return `#${id}/library`;
    case 'saved':
      return `#${id}/saved/${encodeURIComponent(target.run)}${target.section === undefined ? '' : `/${target.section}`}`;
    case 'policy':
      return `#${id}/policy/${encodeURIComponent(target.policy)}`;
  }
}
