import type { CopyText } from '../copy/text.ts';
import './items.css';

/** The marks and handles of the item primitives, drawn in code (no image, no CSS text). */
export type GlyphKind = 'check' | 'ring' | 'star' | 'question' | 'warning' | 'grip' | 'up' | 'down';

/** One glyph, hidden from assistive technology: whoever uses it names its meaning in text. */
export function Glyph({ kind }: { readonly kind: GlyphKind }) {
  const common = {
    className: 'tp-glyph',
    viewBox: '0 0 12 12',
    'aria-hidden': true,
    focusable: false,
  } as const;
  switch (kind) {
    case 'check':
      return (
        <svg {...common}>
          <path
            d="M2 6.5 L4.8 9 L10 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'ring':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <path
            d="M6 0.9 L7.5 4.3 L11.2 4.6 L8.4 7 L9.3 10.7 L6 8.7 L2.7 10.7 L3.6 7 L0.8 4.6 L4.5 4.3 Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'question':
      return (
        <svg {...common}>
          <path
            d="M4.3 4.4 A1.7 1.7 0 1 1 6.6 6 Q6 6.4 6 7.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="6" cy="9.6" r="0.8" fill="currentColor" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M6 1.2 L11.2 10.4 L0.8 10.4 Z" fill="none" stroke="currentColor" />
          <path d="M6 4.6 L6 7.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="8.9" r="0.7" fill="currentColor" />
        </svg>
      );
    case 'grip':
      return (
        <svg {...common}>
          <circle cx="4" cy="2.5" r="1" fill="currentColor" />
          <circle cx="8" cy="2.5" r="1" fill="currentColor" />
          <circle cx="4" cy="6" r="1" fill="currentColor" />
          <circle cx="8" cy="6" r="1" fill="currentColor" />
          <circle cx="4" cy="9.5" r="1" fill="currentColor" />
          <circle cx="8" cy="9.5" r="1" fill="currentColor" />
        </svg>
      );
    case 'up':
      return (
        <svg {...common}>
          <path
            d="M6 10 L6 2.5 M2.8 5.5 L6 2.3 L9.2 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'down':
      return (
        <svg {...common}>
          <path
            d="M6 2 L6 9.5 M2.8 6.5 L6 9.7 L9.2 6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

/** A mark that carries meaning of its own: an image role with its catalogue name. */
export function Mark({ kind, label }: { readonly kind: GlyphKind; readonly label: CopyText }) {
  return (
    <span role="img" aria-label={label} className="tp-mark" data-mark={kind}>
      <Glyph kind={kind} />
    </span>
  );
}
