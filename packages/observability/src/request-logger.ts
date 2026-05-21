import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const child = logger.child({ reqId });

    await next();

    child.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
      },
      "request",
    );
  };
}
