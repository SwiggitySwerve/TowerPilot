import { recognitionAdvanced as t } from '../../../copy/recognitionAdvanced.ts';
import { selectAdvancedText } from '../../../store/selectors/recognitionAdvanced.ts';
import { ServerValue } from '../../../ui/ServerValue.tsx';
export function Data({ value }: { readonly value: unknown }) {
  const shown = selectAdvancedText(value);
  return shown === null ? <>{t.empty.short}</> : <ServerValue value={shown} kind="detail" />;
}
