import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // r6 is the production contract (B-04): tests/r6 runs in every run.
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    // The safety ledger is judged from this run's own results (tests/spec/ledgerReporter.ts).
    reporters: ['default', './tests/spec/ledgerReporter.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
      include: ['tests/**/*.test-d.ts'],
    },
  },
});
