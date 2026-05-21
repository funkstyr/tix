import type { MiddlewareHandler } from "hono";
import { pino, type Logger, type LoggerOptions } from "pino";

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    ...options,
  });
}

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
    const child = logger.child({ reqId });

    c.set("logger", child);

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
