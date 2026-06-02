// Transparent pass-through for browser RUM telemetry (ADR-0013). NOT an instrumented edge:
// the Faro export is a telemetry conduit, so it opens no span (wrapping it would emit a
// gateway span on every RUM flush — self-referential trace noise). The browser→backend trace
// STITCH rides `traceparent` on the real RPC fetches, not on this channel.
//
// Guard: the caller's CORS origin check (gateway-app.ts) bounds browsers; this adds a
// body-size cap so a non-browser client can't trivially flood the collector. Residual
// "curl within the cap" risk is accepted for now (ADR-0013).

const FORWARD_TIMEOUT_MS = 5_000;

export type FaroProxyDeps = {
  faroCollectorUrl: string;
  fetch: typeof globalThis.fetch;
  maxBodyBytes: number;
};

export type FaroProxy = (req: Request) => Promise<Response>;

export function createFaroProxy(deps: FaroProxyDeps): FaroProxy {
  return async (req) => {
    // Buffer the body to enforce the size cap (RUM batches are small). An oversized batch is
    // dropped at the edge, never forwarded.
    const body = await req.arrayBuffer();
    if (body.byteLength > deps.maxBodyBytes) {
      return new Response("payload too large", { status: 413 });
    }

    const headers = new Headers();
    const contentType = req.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);

    const upstream = await deps.fetch(deps.faroCollectorUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
    });
  };
}
