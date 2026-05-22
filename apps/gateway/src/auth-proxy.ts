export const AUTH_PROXY_PREFIX = "/api/auth";

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
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      upstreamHeaders.append(key, value);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "manual",
    };
    if (hasBody) {
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
    if (key.toLowerCase() === "set-cookie") continue;
    out.append(key, value);
  }
  for (const cookie of upstream.getSetCookie()) {
    out.append("set-cookie", cookie);
  }

  return out;
}
