import { ORPCError } from "@orpc/server";
import { APIError } from "better-auth/api";
import { Cause, Effect, Exit, type ManagedRuntime, Option } from "effect";

// better-auth signals failures as `APIError` with an HTTP status; map that status to
// the matching oRPC code so callers see the same UNAUTHORIZED / CONFLICT / … contract
// they did before the Effect migration. An unmapped status falls through to a 500.
const STATUS_TO_ORPC_CODE: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
};

export function toOrpcError(error: APIError): ORPCError<string, unknown> {
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
  const code = STATUS_TO_ORPC_CODE[statusCode] ?? "INTERNAL_SERVER_ERROR";
  const message = error.body?.message ?? "Authentication failed";

  return new ORPCError(code, { status: statusCode, message });
}

// Runs a better-auth promise and lifts its failures into the typed `E` channel: an
// `APIError` becomes the translated `ORPCError`, an `ORPCError` thrown by a handler
// passes through unchanged, and anything else becomes a defect so an unexpected throw
// still surfaces as a 500 exactly as it did before.
export function tryAuth<A>(thunk: () => Promise<A>): Effect.Effect<A, ORPCError<string, unknown>> {
  return Effect.tryPromise({ try: thunk, catch: (e) => e }).pipe(
    Effect.catchAll((error) => {
      if (error instanceof ORPCError) return Effect.fail(error);
      if (error instanceof APIError) return Effect.fail(toOrpcError(error));

      return Effect.die(error);
    }),
  );
}

// Runs an oRPC handler's Effect program on the auth runtime and reproduces the
// imperative throw-at-the-boundary contract: a typed `ORPCError` is rethrown unchanged
// (oRPC turns it into the right HTTP status), and a defect surfaces as the squashed
// cause, which oRPC turns into a 500.
export function makeRunHandler<R>(runtime: ManagedRuntime.ManagedRuntime<R, never>) {
  return async function runHandler<A>(
    program: Effect.Effect<A, ORPCError<string, unknown>, R>,
  ): Promise<A> {
    const exit = await runtime.runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit.value;

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }

    throw Cause.squash(exit.cause);
  };
}
