import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  ReplayPolicy,
} from "@nats-io/jetstream";
import type { JsMsg, PubAck } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Context } from "@opentelemetry/api";
import { ArkErrors, type Type } from "arktype";
import { Cause, Effect, Exit, Scope, Stream } from "effect";

import { extractTraceContext, injectTraceContext } from "./traceparent";

const MSG_ID_HEADER = "Nats-Msg-Id";

export type PublishOptions = {
  msgId?: string;
  /**
   * OTel context whose active span becomes the parent of the downstream consume.
   * Injected into NATS headers as W3C trace context; the payload is untouched.
   * Pass the context reconstructed at the outbox boundary — there is no fallback
   * to the ambient active context, which would be the relay poll, not the cause.
   */
  traceContext?: Context;
};

export type Publisher = {
  publish: (
    subject: string,
    payload: unknown,
    options?: PublishOptions,
  ) => Promise<{ ack: PubAck }>;
};

// JetStream's `publish` awaits a server ack; without a bound it can hang indefinitely if the
// broker stalls. The relay runs this outside Effect (a vanilla poll loop), so resilience here
// is a plain timeout — a rejected publish leaves the outbox row unsent for the next poll to
// retry, which is the relay's existing retry mechanism (ADR-0008, #132).
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;

export function withPublishTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  subject: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`nats publish timed out after ${timeoutMs}ms: ${subject}`)),
      timeoutMs,
    );
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export type PublisherOptions = {
  publishTimeoutMs?: number;
};

export function createPublisher(
  natsConnection: NatsConnection,
  options: PublisherOptions = {},
): Publisher {
  const js = jetstream(natsConnection);
  const encoder = new TextEncoder();
  const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  return {
    publish: async (subject, payload, opts) => {
      const data = encoder.encode(JSON.stringify(payload));
      const pubOpts = {
        ...(opts?.msgId === undefined ? {} : { msgID: opts.msgId }),
        ...(opts?.traceContext === undefined
          ? {}
          : { headers: injectTraceContext(opts.traceContext) }),
      };
      const ack = await withPublishTimeout(
        js.publish(subject, data, pubOpts),
        publishTimeoutMs,
        subject,
      );

      return { ack };
    },
  };
}

export type ConsumerHandlerArgs<Payload> = {
  subject: string;
  payload: Payload;
  eventId: string;
  /**
   * W3C trace context extracted from the message headers. Always a usable context:
   * `ROOT_CONTEXT` when the message carried none, so the handler starts a fresh trace
   * rather than continuing one.
   */
  traceContext: Context;
  ack: () => void;
};

export type ConsumerHandler<Payload, E, R> = (
  args: ConsumerHandlerArgs<Payload>,
) => Effect.Effect<void, E, R>;

export type ConsumerOptions<Payload, E, R> = {
  stream: string;
  subjectFilter: string;
  group: string;
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload, E, R>;
  ackWaitMs?: number;
};

export type RunningConsumer = {
  stop: () => Promise<void>;
};

/**
 * The JetStream consumer as an Effect program. Establishes the durable consumer and the
 * subscription (failures here are defects → boot fails, as before), then forks a `Stream`
 * over the message async-iterable into the current `Scope`. The returned Effect completes
 * once the subscription is established, so callers can rely on readiness. Closing the Scope
 * runs the finalizer (`messages.close()`), ending the iterable and the forked loop.
 *
 * Finalizer ordering: `Effect.forkScoped` registers the fiber-interrupt finalizer first.
 * `Effect.addFinalizer` for `messages.close()` is called after the fork, so it runs FIRST
 * in LIFO order — closing the iterator unblocks the stream loop, letting the fiber exit
 * cleanly before its own finalizer runs.
 */
export function consumer<Payload, E, R>(
  natsConnection: NatsConnection,
  options: ConsumerOptions<Payload, E, R>,
): Effect.Effect<void, never, R | Scope.Scope> {
  const { stream, subjectFilter, group, schema, handler, ackWaitMs } = options;
  const context = { stream, group, subjectFilter };
  const decoder = new TextDecoder();

  return Effect.gen(function* () {
    // Acquire the messages iterator without registering a finalizer yet.
    const messages = yield* Effect.promise(async () => {
      const manager = await jetstreamManager(natsConnection);
      await ensureConsumer(manager, { stream, subjectFilter, group, ackWaitMs });
      const js = jetstream(natsConnection);
      const c = await js.consumers.get(stream, group);
      return await c.consume();
    });

    // Fork the stream loop into the current scope. The fiber-interrupt finalizer is
    // registered first (LIFO means it runs second when scope closes).
    yield* Stream.fromAsyncIterable(messages, (cause) => cause).pipe(
      Stream.runForEach((msg) => processMessage(msg, { schema, handler, decoder, context })),
      Effect.catchAllCause((cause) =>
        Effect.logError("consumer loop terminated").pipe(
          Effect.annotateLogs({ ...context, cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkScoped,
    );

    // Register messages.close() AFTER forking so it runs FIRST in LIFO order.
    // Closing the iterator unblocks any pending asyncIterator.next() call, allowing
    // the forked stream fiber to exit naturally before the fiber-interrupt finalizer runs.
    yield* Effect.addFinalizer(() => Effect.promise(() => messages.close()));
  });
}

/**
 * Lifecycle adapter: runs a `consumer(...)` program on `runtime`, awaiting subscription
 * readiness, and returns a Promise `{ stop }` handle. `runtime` is a service ManagedRuntime
 * (provides the handler's `R`) or `defaultScopedRunner` (for `R = never` harness callers).
 * The held Scope keeps the forked loop alive; `stop` closes it (runs `messages.close()`).
 */
export async function runScopedConsumer<R>(
  runtime: {
    runPromise: <A, E>(effect: Effect.Effect<A, E, R | Scope.Scope>) => Promise<A>;
  },
  program: Effect.Effect<void, never, R | Scope.Scope>,
): Promise<RunningConsumer> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    await runtime.runPromise(Effect.provideService(program, Scope.Scope, scope));
  } catch (err) {
    // Subscription setup failed before the loop was forked; close the (empty) scope so we
    // don't leak it, then surface the failure to the caller (boot fails, as before).
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw err;
  }
  return {
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

/**
 * Default-runtime runner for callers with no service runtime (R = never). `runScopedConsumer`
 * always provides its own managed `Scope` via `provideService`, so this `Effect.scoped` only
 * discharges the residual `Scope` requirement in the type — the provided scope is the one that
 * actually hosts the forked consumer loop.
 */
export const defaultScopedRunner = {
  runPromise: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
    Effect.runPromise(Effect.scoped(effect)),
};

type EnsureConsumerArgs = {
  stream: string;
  subjectFilter: string;
  group: string;
  ackWaitMs: number | undefined;
};

async function ensureConsumer(
  manager: Awaited<ReturnType<typeof jetstreamManager>>,
  { stream, subjectFilter, group, ackWaitMs }: EnsureConsumerArgs,
): Promise<void> {
  try {
    await manager.consumers.info(stream, group);
    return;
  } catch (err) {
    if (!isConsumerNotFound(err)) throw err;
  }

  await manager.consumers.add(stream, {
    durable_name: group,
    filter_subject: subjectFilter,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,
    ...(ackWaitMs === undefined ? {} : { ack_wait: ackWaitMs * 1_000_000 }),
  });
}

type ConsumerContext = { stream: string; group: string; subjectFilter: string };

type ProcessMessageArgs<Payload, E, R> = {
  schema: Type<Payload>;
  handler: ConsumerHandler<Payload, E, R>;
  decoder: TextDecoder;
  context: ConsumerContext;
};

function processMessage<Payload, E, R>(
  msg: JsMsg,
  { schema, handler, decoder, context }: ProcessMessageArgs<Payload, E, R>,
): Effect.Effect<void, never, R> {
  return Effect.gen(function* () {
    const subject = msg.subject;
    const eventId = msg.headers?.get(MSG_ID_HEADER);

    if (!eventId) {
      yield* Effect.logWarning(`event missing ${MSG_ID_HEADER} header; terminating`).pipe(
        Effect.annotateLogs({ ...context, subject }),
      );
      msg.term(`missing ${MSG_ID_HEADER} header`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(msg.data));
    } catch (err) {
      yield* Effect.logWarning("event payload is not valid JSON; terminating").pipe(
        Effect.annotateLogs({ ...context, eventId, subject, err: String(err) }),
      );
      msg.term("invalid json");
      return;
    }

    const validated = schema(parsed);
    if (validated instanceof ArkErrors) {
      yield* Effect.logWarning("event payload failed schema validation; terminating").pipe(
        Effect.annotateLogs({ ...context, eventId, subject, summary: validated.summary }),
      );
      msg.term("schema validation failed");
      return;
    }

    let settled = false;
    const ack = (): void => {
      if (settled) return;
      settled = true;
      msg.ack();
    };

    const traceContext = extractTraceContext(msg.headers);

    yield* handler({ subject, payload: validated as Payload, eventId, traceContext, ack }).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Effect.sync(() => ack()),
        onFailure: (cause) =>
          settled
            ? Effect.logError("handler failed after acking; not redelivering").pipe(
                Effect.annotateLogs({
                  ...context,
                  eventId,
                  subject,
                  redelivered: msg.redelivered,
                  cause: Cause.pretty(cause),
                }),
              )
            : Effect.sync(() => {
                settled = true;
                msg.nak();
              }).pipe(
                Effect.zipRight(
                  Effect.logError("handler failed; nak-ing for redelivery").pipe(
                    Effect.annotateLogs({
                      ...context,
                      eventId,
                      subject,
                      redelivered: msg.redelivered,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
              ),
      }),
    );
  });
}

// Test-only export: the fast unit test fakes a JsMsg and drives this directly.
export const processMessageForTest = processMessage;

function isConsumerNotFound(err: unknown): boolean {
  return err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound;
}
