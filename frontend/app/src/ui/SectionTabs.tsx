import { useLayoutEffect, useState } from 'react';
import type { CopyNode, CopyText } from '../copy/text.ts';
import { ValidationSummary } from './ValidationSummary.tsx';
import './ui.css';

export interface SectionChoice<K extends string> {
  readonly key: K;
  readonly label: CopyText;
}

export interface SectionTabsProps<K extends string> {
  /** Names the row for assistive technology ("Runs sections"). */
  readonly label: CopyText;
  /** Each section's panel is `${idPrefix}-${key}` (SectionPanel). */
  readonly idPrefix: string;
  readonly sections: readonly SectionChoice<K>[];
  readonly current: K;
  readonly onSelect: (key: K) => void;
}

const INVALID = '[aria-invalid="true"]';

/** How many invalid fields each section's panel holds, kept current as fields change. */
function useProblems(idPrefix: string, keys: readonly string[]): Readonly<Record<string, number>> {
  const [problems, setProblems] = useState<Readonly<Record<string, number>>>({});
  const joined = keys.join(' ');
  useLayoutEffect(() => {
    const panels = joined
      .split(' ')
      .map((key) => [key, document.getElementById(`${idPrefix}-${key}`)] as const);
    const count = () => {
      const next: Record<string, number> = {};
      for (const [key, panel] of panels) next[key] = panel?.querySelectorAll(INVALID).length ?? 0;
      setProblems((previous) =>
        panels.every(([key]) => previous[key] === next[key]) ? previous : next,
      );
    };
    count();
    const observer = new MutationObserver(count);
    for (const [, panel] of panels) {
      if (panel !== null)
        observer.observe(panel, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-invalid'],
        });
    }
    return () => {
      observer.disconnect();
    };
  }, [idPrefix, joined]);
  return problems;
}

/**
 * One section of a long page at a time: the legacy day-tab row (a row of buttons, the shown
 * one pressed). A section holding an invalid field says so on its button, so a problem is
 * never hidden behind another section.
 */
export function SectionTabs<K extends string>({
  label,
  idPrefix,
  sections,
  current,
  onSelect,
}: SectionTabsProps<K>) {
  const problems = useProblems(
    idPrefix,
    sections.map((section) => section.key),
  );
  return (
    <nav aria-label={label} className="tp-sections tp-control-row" data-sections={idPrefix}>
      {sections.map((section) => (
        <button
          key={section.key}
          type="button"
          className="tp-button tp-sections__tab"
          aria-pressed={section.key === current}
          aria-controls={`${idPrefix}-${section.key}`}
          data-section={section.key}
          onClick={() => {
            onSelect(section.key);
          }}
        >
          <span>{section.label}</span>
          <ValidationSummary problems={problems[section.key] ?? 0} />
        </button>
      ))}
    </nav>
  );
}

/**
 * A section's content. Every panel stays mounted and is only hidden while another is shown,
 * so drafts, timers and focus targets keep working; shown, it adds no box of its own.
 */
export function SectionPanel({
  idPrefix,
  section,
  current,
  children,
}: {
  readonly idPrefix: string;
  readonly section: string;
  readonly current: string;
  readonly children: CopyNode;
}) {
  return (
    <div
      id={`${idPrefix}-${section}`}
      className="tp-section-panel"
      data-section-panel={section}
      hidden={section !== current}
    >
      {children}
    </div>
  );
}
