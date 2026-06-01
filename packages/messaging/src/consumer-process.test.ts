import { describe, expect, it } from "@effect/vitest";
import type { JsMsg } from "@nats-io/jetstream";
import { type } from "arktype";
import { Effect } from "effect";

import { processMessageForTest, type ConsumerHandler } from "./jetstream.ts";

const schema = type({ ok: "boolean" });

type FakeMsg = {
  subject: string;
  data: Uint8Array;
  headers?: {
    get: (k: string) => string | undefined;
    has: (k: string) => boolean;
    keys: () => string[];
  };
  redelivered: boolean;
  acked: boolean;
  nakked: boolean;
  termed?: string;
  ack: () => void;
  nak: () => void;
  term: (reason?: string) => void;
};

function makeMsg(opts: { eventId?: string; body?: unknown; raw?: Uint8Array }): FakeMsg {
  return {
    subject: "tickets.created.v1",
    data: opts.raw ?? new TextEncoder().encode(JSON.stringify(opts.body ?? { ok: true })),
    headers:
      opts.eventId === undefined
        ? undefined
        : {
            // Mirror the MsgHdrs subset the W3C trace-context getter touches (get/has/keys)
            // so production trace extraction needs no test-only defensiveness.
            get: (k: string) => (k === "Nats-Msg-Id" ? opts.eventId : undefined),
            has: (k: string) => k === "Nats-Msg-Id",
            keys: () => ["Nats-Msg-Id"],
          },
    redelivered: false,
    acked: false,
    nakked: false,
    ack() {
      this.acked = true;
    },
    nak() {
      this.nakked = true;
    },
    term(reason?: string) {
      this.termed = reason ?? "";
    },
  };
}

const noopHandler: ConsumerHandler<{ ok: boolean }, never, never> = () => Effect.void;
const failHandler: ConsumerHandler<{ ok: boolean }, string, never> = () => Effect.fail("boom");
const ackThenFailHandler: ConsumerHandler<{ ok: boolean }, string, never> = ({ ack }) =>
  Effect.sync(() => ack()).pipe(Effect.zipRight(Effect.fail("after-ack")));
const ctx = { stream: "S", group: "g", subjectFilter: "tickets.created.v1" };

// processMessageForTest expects a JsMsg; the fake implements the subset it touches.
const run = (
  msg: FakeMsg,
  handler:
    | ConsumerHandler<{ ok: boolean }, never, never>
    | ConsumerHandler<{ ok: boolean }, string, never>,
) =>
  processMessageForTest(msg as unknown as JsMsg, {
    schema,
    handler: handler as ConsumerHandler<{ ok: boolean }, unknown, never>,
    decoder: new TextDecoder(),
    context: ctx,
  });

describe("processMessage", () => {
  it.effect("acks on handler success", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1" });
      yield* run(msg, noopHandler);
      expect(msg.acked).toBe(true);
      expect(msg.nakked).toBe(false);
    }),
  );

  it.effect("terms when the Nats-Msg-Id header is missing", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ body: { ok: true } });
      yield* run(msg, noopHandler);
      expect(msg.termed).toBe("missing Nats-Msg-Id header");
      expect(msg.acked).toBe(false);
    }),
  );

  it.effect("terms on invalid JSON", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1", raw: new TextEncoder().encode("{not json") });
      yield* run(msg, noopHandler);
      expect(msg.termed).toBe("invalid json");
    }),
  );

  it.effect("terms on schema validation failure", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1", body: { ok: "nope" } });
      yield* run(msg, noopHandler);
      expect(msg.termed).toBe("schema validation failed");
    }),
  );

  it.effect("naks when the handler fails before acking", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1" });
      yield* run(msg, failHandler);
      expect(msg.nakked).toBe(true);
      expect(msg.acked).toBe(false);
    }),
  );

  it.effect("does not nak when the handler acks early then fails", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1" });
      yield* run(msg, ackThenFailHandler);
      expect(msg.acked).toBe(true);
      expect(msg.nakked).toBe(false);
    }),
  );

  it.effect("naks when the handler throws (defect) before acking", () =>
    Effect.gen(function* () {
      const msg = makeMsg({ eventId: "e1" });
      // A thrown error is a defect (Cause.Die), not a typed failure; matchCauseEffect must
      // still nak for redelivery — same at-least-once guarantee as a typed Effect.fail.
      yield* run(msg, () =>
        Effect.sync(() => {
          throw new Error("boom");
        }),
      );
      expect(msg.nakked).toBe(true);
      expect(msg.acked).toBe(false);
    }),
  );
});
