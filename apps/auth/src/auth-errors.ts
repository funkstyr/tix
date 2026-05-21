import { ORPCError } from "@orpc/server";

type ApiErrorLike = {
  status?: string | number;
  statusCode?: number;
  body?: { code?: string; message?: string } | undefined;
};

function isApiError(value: unknown): value is ApiErrorLike {
  if (typeof value !== "object" || value === null) return false;

  const v = value as Record<string, unknown>;

  return (
    typeof v["statusCode"] === "number" ||
    typeof v["status"] === "string" ||
    typeof v["status"] === "number"
  );
}

const STATUS_TO_ORPC_CODE: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
};

export function rethrowAsOrpc(error: unknown): never {
  if (!isApiError(error)) {
    throw error;
  }

  const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
  const code = STATUS_TO_ORPC_CODE[statusCode] ?? "INTERNAL_SERVER_ERROR";
  const message = error.body?.message ?? "Authentication failed";

  throw new ORPCError(code, { status: statusCode, message });
}
