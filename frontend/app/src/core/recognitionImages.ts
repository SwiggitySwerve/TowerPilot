import { finite, id, list, own, ownPath, stringList, text } from './read.ts';
import { operationView } from './recognition.ts';

/** R9-R11 rules: image presence, observed matches and verified recognition remain separate.
 * Native-pixel crops belong to one explicit still-frame token. No reader authorizes input.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export function nativeSize(raw: unknown): Size | null {
  const a = list(raw);
  const width = finite(a?.[0]);
  const height = finite(a?.[1]);
  return width !== undefined && height !== undefined && width > 0 && height > 0
    ? { width, height }
    : null;
}
export function nativeRect(raw: unknown): Rect | null {
  const a = list(raw);
  const x = finite(a?.[0]);
  const y = finite(a?.[1]);
  const w = finite(a?.[2]);
  const h = finite(a?.[3]);
  return x === undefined || y === undefined || w === undefined || h === undefined
    ? null
    : { x, y, w, h };
}
export interface CropDraft {
  readonly name: string;
  readonly x: string;
  readonly y: string;
  readonly w: string;
  readonly h: string;
}
export const EMPTY_CROP: CropDraft = { name: '', x: '', y: '', w: '', h: '' };
export function validTemplateName(name: string): boolean {
  return (
    /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+\.png$/u.test(name) &&
    !name.split('/').some((p) => p === '.' || p === '..')
  );
}
export function draftRectangle(draft: CropDraft): Rect | null {
  const values = [draft.x, draft.y, draft.w, draft.h];
  return values.some((v) => !/^\d+$/u.test(v) || !Number.isSafeInteger(Number(v)))
    ? null
    : { x: Number(draft.x), y: Number(draft.y), w: Number(draft.w), h: Number(draft.h) };
}
export function cropCheck(
  draft: CropDraft,
  size: Size | null,
):
  | { readonly kind: 'valid'; readonly rect: Rect }
  | { readonly kind: 'invalid'; readonly reason: 'name' | 'numbers' | 'bounds' | 'frame' } {
  if (!validTemplateName(draft.name)) return { kind: 'invalid', reason: 'name' };
  const rect = draftRectangle(draft);
  if (rect === null) return { kind: 'invalid', reason: 'numbers' };
  if (size === null) return { kind: 'invalid', reason: 'frame' };
  if (rect.w < 6 || rect.h < 6 || rect.x + rect.w > size.width || rect.y + rect.h > size.height)
    return { kind: 'invalid', reason: 'bounds' };
  return { kind: 'valid', rect };
}
/** Pointer coordinates are presentation geometry; captured pixels always use the native frame. */
export function dragRect(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  display: Size,
  native: Size,
): Rect {
  const point = (v: number, limit: number, scale: number) =>
    Math.round(Math.max(0, Math.min(limit, v)) * scale);
  const ax = point(start.x, display.width, native.width / display.width),
    ay = point(start.y, display.height, native.height / display.height);
  const bx = point(end.x, display.width, native.width / display.width),
    by = point(end.y, display.height, native.height / display.height);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) };
}
function flag(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null;
}
export interface RepairTarget {
  readonly rel: string;
  readonly label: string;
  readonly status: string | null;
  readonly required: boolean | null;
  readonly automatic: boolean | null;
  readonly learned: Rect | null;
  readonly learnedSize: Size | null;
  readonly reference: Size | null;
}
export function scanPlan(raw: unknown) {
  return {
    native: nativeSize(own(raw, 'native_frame')),
    captured: finite(own(raw, 'captured')) ?? null,
    total: finite(own(raw, 'total')) ?? null,
    note: text(own(raw, 'note')) ?? null,
    mapping: (list(ownPath(raw, 'mapping', 'steps')) ?? []).map((s, i) => ({
      id: id(own(s, 'id')) ?? String(i),
      source: text(own(s, 'source')) ?? null,
      destination: text(own(s, 'destination')) ?? null,
      status: text(own(s, 'status')) ?? null,
      action: text(own(s, 'action')) ?? null,
    })),
    interface: (list(ownPath(raw, 'interface', 'screens')) ?? []).map((s, i) => ({
      id: id(own(s, 'id')) ?? String(i),
      label: text(own(s, 'label')) ?? null,
      status: text(own(s, 'status')) ?? null,
      total: finite(own(s, 'total')) ?? null,
      verified: finite(own(s, 'verified')) ?? null,
      controls: list(own(s, 'controls')) ?? [],
    })),
    steps: (list(own(raw, 'steps')) ?? []).map((s, i) => ({
      id: id(own(s, 'id')) ?? String(i),
      title: text(own(s, 'title')) ?? null,
      instructions: text(own(s, 'instructions')) ?? null,
      mode: text(own(s, 'mode')) ?? null,
      targets: (list(own(s, 'targets')) ?? []).flatMap((t): RepairTarget[] => {
        const rel = id(own(t, 'rel'));
        return rel === undefined
          ? []
          : [
              {
                rel,
                label: text(own(t, 'label')) ?? rel,
                status: text(own(t, 'status')) ?? null,
                required: flag(own(t, 'required')),
                automatic: flag(own(t, 'automatic')),
                learned: nativeRect(ownPath(t, 'learned', 'rect')),
                learnedSize: nativeSize(ownPath(t, 'learned', 'frame_size')),
                reference: nativeSize(own(t, 'reference_size')),
              },
            ];
      }),
    })),
  };
}
export function requiredImages(raw: unknown) {
  return {
    missing: stringList(own(raw, 'missing')) ?? [],
    rows: (list(own(raw, 'required')) ?? []).flatMap((t) => {
      const rel = id(own(t, 'rel'));
      return rel === undefined
        ? []
        : [
            {
              rel,
              feature: text(own(t, 'feature')) ?? null,
              have: flag(own(t, 'have')),
              note: text(own(t, 'note')) ?? null,
              usedBy: stringList(own(t, 'used_by')) ?? [],
            },
          ];
    }),
  };
}
export function templateInventory(raw: unknown) {
  const have = stringList(own(raw, 'have')) ?? [];
  const groups = new Map<string, string[]>();
  for (const rel of have) {
    const folder = rel.slice(0, rel.lastIndexOf('/'));
    const group = groups.get(folder) ?? [];
    group.push(rel);
    groups.set(folder, group);
  }
  return {
    have,
    missingSeen: stringList(own(raw, 'missing_seen')) ?? [],
    groups: [...groups].map(([folder, images]) => ({ folder, images })),
  };
}
export function moduleCatalogue(raw: unknown) {
  return (list(own(raw, 'modules')) ?? []).flatMap((m) => {
    const slug = id(own(m, 'slug'));
    return slug === undefined
      ? []
      : [
          {
            slug,
            name: text(own(m, 'name')) ?? slug,
            abbrevs: stringList(own(m, 'abbrevs')) ?? [],
            learned: flag(own(m, 'learned')),
          },
        ];
  });
}
export function analysisStatus(raw: unknown, selected: string | null) {
  const operation = operationView(own(raw, 'operation'));
  const belongs =
    selected !== null && operation?.id === selected && operation.kind === 'screen_analysis';
  const status = text(own(raw, 'status')) ?? null;
  const matches = belongs
    ? (list(own(raw, 'matches')) ?? []).map((m, i) => ({
        id: String(i),
        names: stringList(own(m, 'names')) ?? [],
        roles: stringList(own(m, 'roles')) ?? [],
        rect: nativeRect(own(m, 'rect')),
        ambiguous: own(m, 'ambiguous') === true,
        inliers: finite(own(m, 'inliers')) ?? null,
      }))
    : [];
  const size = nativeSize([own(raw, 'width'), own(raw, 'height')]);
  return {
    operation,
    status: belongs || selected === null || selected === '' ? status : null,
    message: text(own(raw, 'message')) ?? text(own(raw, 'error')) ?? null,
    code: text(own(raw, 'code')) ?? operation?.error?.code ?? null,
    screen: text(ownPath(raw, 'screen', 'name')) ?? null,
    candidates: stringList(ownPath(raw, 'screen', 'candidates')) ?? [],
    tested: finite(own(raw, 'tested')) ?? null,
    total: finite(own(raw, 'total')) ?? null,
    completed: finite(own(raw, 'completed')) ?? null,
    capturedAt: finite(own(raw, 'captured_at')) ?? null,
    size,
    matches,
    frame:
      belongs && status === 'done' && operation.status === 'succeeded'
        ? `/api/screen-analysis/frame.png?operation_id=${encodeURIComponent(selected)}&revision=${String(operation.revision ?? '')}`
        : null,
  };
}
export function imagePath(rel: string): string | null {
  return validTemplateName(rel)
    ? `/api/template/${rel.split('/').map(encodeURIComponent).join('/')}`
    : null;
}
export function restoreCrop(raw: unknown): CropDraft {
  return {
    name: text(own(raw, 'name')) ?? '',
    x: text(own(raw, 'x')) ?? '',
    y: text(own(raw, 'y')) ?? '',
    w: text(own(raw, 'w')) ?? '',
    h: text(own(raw, 'h')) ?? '',
  };
}
