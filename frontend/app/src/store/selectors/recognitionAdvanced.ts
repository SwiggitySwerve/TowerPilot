import { fromServer } from '../../copy/server.ts';
import {
  analysisStatus,
  cropCheck,
  moduleCatalogue,
  requiredImages,
  scanPlan,
  templateInventory,
} from '../../core/recognitionImages.ts';
import {
  advancedPending,
  currentAdvanced,
  type RecognitionAdvancedState,
} from '../recognitionAdvanced.ts';
/** The sanctioned text boundary; text remains server data, never catalogue wording. */
export function selectAdvancedText(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  return fromServer('detail', typeof raw === 'string' ? raw : JSON.stringify(raw));
}
export function selectAdvanced(state: RecognitionAdvancedState, now: number) {
  const target = currentAdvanced(state);
  return {
    target,
    context: state.context,
    online: state.online,
    key: state.key,
    plan: scanPlan(target?.plan),
    required: requiredImages(target?.required),
    templates: templateInventory(target?.templates),
    catalogue: moduleCatalogue(target?.catalogue),
    analysis: analysisStatus(target?.analysis, target?.selectedOperation ?? null),
    cropCheck: cropCheck(
      target?.draft ?? { name: '', x: '', y: '', w: '', h: '' },
      target?.frame?.size ?? null,
    ),
    launchPending: advancedPending(target?.launch ?? null),
    cropPending: advancedPending(target?.crop ?? null),
    stale: target?.readAt != null && now - target.readAt > 30000,
    analysisStale: target?.analysisAt != null && now - target.analysisAt > 30000,
  };
}
