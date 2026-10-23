/** RL3 uses the shared profile-patch writer and journal, including its context reservation,
 * one-send contract, raw-draft capture and read-only settlement. No second write protocol. */
export { sendProfilePatch as sendRunEntryPatch } from './collection.ts';
