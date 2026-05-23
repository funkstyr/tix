const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

const CLIENT_FORWARDED = new Set([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
]);

export type AuthProxyDeps = {
  authBaseUrl: string;
  fetch: typeof globalThis.fetch;
};

export type AuthProxy = (req: Request) => Promise<Response>;

export function createAuthProxy(deps: AuthProxyDeps): AuthProxy {
  const baseUrl = deps.authBaseUrl.replace(/\/$/, "");

  return async (req) => {
    const url = new URL(req.url);
    const upstreamUrl = `${baseUrl}${url.pathname}${url.search}`;

    const upstreamHeaders = new Headers();
    for (const [key, value] of req.headers) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (CLIENT_FORWARDED.has(lower)) continue;
      upstreamHeaders.append(key, value);
    }

    // `duplex` is required by Node's fetch when streaming a body; libdom omits it.
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "manual",
    };
    if (req.body !== null) {
      init.body = req.body;
      init.duplex = "half";
    }

    const upstream = await deps.fetch(upstreamUrl, init);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers),
    });
  };
}

function copyResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") continue;
    if (HOP_BY_HOP.has(lower)) continue;
    out.append(key, value);
  }
  for (const cookie of upstream.getSetCookie()) {
    out.append("set-cookie", cookie);
  }

  return out;
}
