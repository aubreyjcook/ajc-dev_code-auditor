import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * Tests live under `tests/` and never hit a real LLM: they use the `mock`
 * provider or stubbed `fetch`. Playwright-based crawling is exercised against
 * an in-process HTTP server so no network access is required.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: 'node',
    // Playwright tests spin up a browser; keep them isolated from each other.
    pool: 'forks',
  },
});
