// Hard-coded port the Vite dev server binds to during the e2e run. Fixing
// it lets us pass `webOrigin: http://localhost:${WEB_PORT}` to the canary
// stack at boot (so CORS matches) without needing to discover the port after
// Vite is already up. The gateway, in contrast, can take any free port —
// `startCanaryStack` returns its actual bound URL.
//
// The unusual value avoids collisions with the dev default (vite 5173) so an
// accidental `pnpm dev` in another terminal doesn't make the e2e suite look
// like it passed against the wrong stack.
export const WEB_PORT = 5273;
