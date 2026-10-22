// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * ADR-001 rule 5 for stylesheets: CSS can draw words too (`content: "..."` on
 * a pseudo-element, or `attr()` copying an attribute onto the screen). Every
 * `content` declaration in src/ is empty or `none`/`normal`. Declarations are
 * read by a CSS parser (postcss), so comments are skipped, and property names
 * are compared as CSS does: case-insensitive, with escapes resolved.
 */
const SRC = path.resolve(fileURLToPath(import.meta.url), '../../../src');
const ALLOWED = new Set(['""', "''", 'none', 'normal']);

function stylesheets(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

/** A CSS identifier with its escapes resolved (`c\6f ntent`, `c\ontent`), lower-cased. */
function identifier(raw: string): string {
  return raw
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_escape, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, '$1')
    .toLowerCase();
}

/** The values of every `content` declaration; `justify-content` and comments are not matched. */
export function contentDeclarations(css: string): string[] {
  const values: string[] = [];
  parse(css).walkDecls((declaration) => {
    if (identifier(declaration.prop) === 'content') {
      values.push(declaration.value.trim());
    }
  });
  return values;
}

describe('stylesheets carry no wording', () => {
  it('finds content in any spelling and ignores comments and justify-content (discriminating control)', () => {
    expect(
      contentDeclarations(
        [
          'a::before { content: "Invented"; justify-content: center; }',
          'b::after { CONTENT: attr(title) }',
          'i::after { c\\6f ntent: "Escaped"; c\\ontent: "Also" }',
          '/* content: "Example only"; */ .a { display: block; }',
        ].join('\n'),
      ),
    ).toEqual(['"Invented"', 'attr(title)', '"Escaped"', '"Also"']);
  });

  it.each(stylesheets(SRC).map((file) => [path.relative(SRC, file), file] as const))(
    '%s draws no text through content',
    (_name, file) => {
      const found = contentDeclarations(readFileSync(file, 'utf8')).filter(
        (value) => !ALLOWED.has(value),
      );
      expect(found).toEqual([]);
    },
  );
});
