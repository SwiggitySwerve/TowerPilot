import { createElement } from 'react';
import { RecognitionPage } from '../features/recognition/RecognitionPage.tsx';
import { ConnectedAdvancedRepairs } from './recognitionAdvanced.ts';

/** The Recognition page with its advanced repairs (R9 to R11, their own store) mounted inside. */
export function ConnectedRecognitionPage() {
  return createElement(RecognitionPage, { Advanced: ConnectedAdvancedRepairs });
}
