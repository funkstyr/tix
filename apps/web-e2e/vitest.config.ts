import { nodePreset } from "@tix/config/vitest";

// Unit tests only (src/**). The Playwright suites in tests/*.spec.ts are driven
// by `test:e2e` (playwright test), not vitest — restrict include so vitest never
// tries to collect them.
export default nodePreset({ include: ["src/**/*.test.ts"] });
