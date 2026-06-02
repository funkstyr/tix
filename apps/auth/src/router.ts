import { type Context as OtelContext, ROOT_CONTEXT } from "@opentelemetry/api";
import { ORPCError, os } from "@orpc/server";
import { Effect } from "effect";

import {
  credentialsOutput,
  okOutput,
  sessionOutput,
  signInInput,
  signUpInput,
  tokenInput,
} from "@tix/contracts/auth";
import { SpanAttr } from "@tix/observability/attributes";
import { externalParent } from "@tix/observability/otel-trace";
import { withResilience, withTimeout } from "@tix/observability/resilience";

import { makeRunHandler, tryAuth } from "./auth-boundary.ts";
import { type AuthOp, instrumentAuth, recordSessionValidation } from "./auth-metrics.ts";
import type { AuthRuntime } from "./auth-runtime.ts";
import { Auth } from "./auth-services.ts";

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

// Threaded from the Hono boundary (auth-app.ts): the inbound request's trace context, so
// each handler's span continues the caller's trace. auth is on the request path of every
// authenticated call (via `requireSession`), so continuing `traceparent` here closes a
// common gap. Optional because in-process callers (the test fixtures other services use)
// drive the router directly with no inbound trace — those spans become fresh roots.
export type AuthRequestContext = {
  otelParent?: OtelContext;
};

// One span per oRPC request, parented onto the inbound trace context when present
// (otherwise a fresh root), plus per-op RED metrics.
function withRequest<A, E, R>(
  op: AuthOp,
  context: AuthRequestContext,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return program.pipe(
    Effect.withSpan(`auth.${op}`, {
      parent: externalParent(context.otelParent ?? ROOT_CONTEXT),
    }),
    instrumentAuth(op),
  );
}

export function createAuthRouter(runtime: AuthRuntime) {
  const run = makeRunHandler(runtime);

  const base = os.$context<AuthRequestContext>();

  const signUp = base
    .input(signUpInput)
    .output(credentialsOutput)
    .handler(({ input, context }) =>
      run(
        withRequest(
          "signUp",
          context,
          Effect.gen(function* () {
            const auth = yield* Auth;
            const result = yield* withTimeout(
              "auth.handler.sign_up",
              tryAuth(() => auth.api.signUpEmail({ body: input })),
            );
            if (result.token === null) {
              return yield* Effect.fail(
                new ORPCError("INTERNAL_SERVER_ERROR", {
                  message: "sign-up did not return a session token",
                }),
              );
            }

            return { userId: result.user.id, email: result.user.email, token: result.token };
          }),
        ),
      ),
    );

  const signIn = base
    .input(signInInput)
    .output(credentialsOutput)
    .handler(({ input, context }) =>
      run(
        withRequest(
          "signIn",
          context,
          Effect.gen(function* () {
            const auth = yield* Auth;
            const result = yield* withTimeout(
              "auth.handler.sign_in",
              tryAuth(() => auth.api.signInEmail({ body: input })),
            );

            return { userId: result.user.id, email: result.user.email, token: result.token };
          }),
        ),
      ),
    );

  const signOut = base
    .input(tokenInput)
    .output(okOutput)
    .handler(({ input, context }) =>
      run(
        withRequest(
          "signOut",
          context,
          Effect.gen(function* () {
            const auth = yield* Auth;
            yield* withTimeout(
              "auth.handler.sign_out",
              tryAuth(() => auth.api.signOut({ headers: bearerHeaders(input.token) })),
            );

            return { ok: true };
          }),
        ),
      ),
    );

  const getSession = base
    .input(tokenInput)
    .output(sessionOutput)
    .handler(({ input, context }) =>
      run(
        withRequest(
          "getSession",
          context,
          Effect.gen(function* () {
            const auth = yield* Auth;
            const result = yield* withResilience(
              "auth.db.get_session",
              tryAuth(() => auth.api.getSession({ headers: bearerHeaders(input.token) })),
            );

            yield* recordSessionValidation(result !== null);
            if (result === null) return null;

            yield* Effect.annotateCurrentSpan(SpanAttr.buyerId, result.user.id);

            return {
              user: { id: result.user.id, email: result.user.email, name: result.user.name },
              session: {
                id: result.session.id,
                expiresAt: result.session.expiresAt.toISOString(),
              },
            };
          }),
        ),
      ),
    );

  return { signUp, signIn, signOut, getSession };
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
