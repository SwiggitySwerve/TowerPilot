import { copy } from '../copy/catalogue.ts';
import './items.css';

/** `ok` filled circle, `warn` diamond, `bad` square, `unknown` hollow ring: shape tells it apart from colour. */
export type DotTone = 'ok' | 'warn' | 'bad' | 'unknown';

/** A small dot before a name or a value. Its text alternative is the tone's catalogue word. */
export function StatusDot({ tone }: { readonly tone: DotTone }) {
  return (
    <span className="tp-dot" data-tone={tone} role="img" aria-label={copy.items.dot[tone].short} />
  );
}
