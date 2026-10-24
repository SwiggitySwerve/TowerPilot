import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // r6 is the production contract (B-04): tests/unit/r6 runs in every run.
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/unit/setup.ts'],
    // The safety ledger is judged from this run's own results (tests/unit/spec/ledgerReporter.ts).
    reporters: ['default', './tests/unit/spec/ledgerReporter.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.test.json',
      include: ['tests/unit/**/*.test-d.ts'],
    },
  },
});
