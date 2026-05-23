import { nodePreset } from "@tix/config/vitest";

// The e2e spec spawns four services as child processes against the local
// docker-compose stack and waits on real timers (reservation expiry + restore
// polling), so the defaults vitest ships are way too tight. One worker keeps
// the fixed service ports unambiguous; `bail: 1` cuts the run as soon as a
// step fails so the next step doesn't fire against a known-broken stack.
export default nodePreset({
  include: ["tests/**/*.test.ts"],
  testTimeout: 60_000,
  hookTimeout: 90_000,
  fileParallelism: false,
  bail: 1,
});
