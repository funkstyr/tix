import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { outboxRelay, type OutboxPublish } from "./outbox.ts";
import { defineOutbox } from "./schema.ts";

type Row = {
  id: string;
  subject: string;
  payload: unknown;
  eventId: string;
  traceparent: string | null;
  createdAt: number;
  sentAt: Date | null;
};

// An in-memory stand-in for the drizzle surface the relay uses. The relay marks a row sent
// with `.update(t).set({sentAt}).where(eq(table.id, row.id))` — drizzle's `eq(...)` SQL
// object is not reliably introspectable, so instead of parsing it we correlate mark-sent
// with the row published most recently. That correlation is valid precisely because the
// relay publishes then marks each row sequentially (concurrency 1) and only marks on a
// successful publish. `notePublished()` is called by the test's publish callback.
function fakeDb(rows: Row[]) {
  let lastPublishedId: string | null = null;
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) =>
                Promise.resolve(
                  rows
                    .filter((r) => r.sentAt === null)
                    .sort((a, b) => a.createdAt - b.createdAt)
                    .slice(0, n)
                    .map((r) => ({
                      id: r.id,
                      subject: r.subject,
                      payload: r.payload,
                      eventId: r.eventId,
                      traceparent: r.traceparent,
                    })),
                ),
            }),
          }),
        }),
      }),
      update: () => ({
        set: (vals: { sentAt: Date }) => ({
          where: () => {
            const row = rows.find((r) => r.id === lastPublishedId);
            if (row) row.sentAt = vals.sentAt;
            return Promise.resolve();
          },
        }),
      }),
    },
    notePublished: (eventId: string) => {
      lastPublishedId = rows.find((r) => r.eventId === eventId)?.id ?? null;
    },
  };
}

const table = defineOutbox("relay_unit_test");

describe("outboxRelay", () => {
  it.effect("publishes pending rows in createdAt order, concurrency 1, marking sent via Clock", () =>
    Effect.gen(function* () {
      const rows: Row[] = [
        { id: "1", subject: "s", payload: { n: 1 }, eventId: "e1", traceparent: null, createdAt: 1, sentAt: null },
        { id: "2", subject: "s", payload: { n: 2 }, eventId: "e2", traceparent: null, createdAt: 2, sentAt: null },
        { id: "3", subject: "s", payload: { n: 3 }, eventId: "e3", traceparent: null, createdAt: 3, sentAt: null },
      ];
      const fake = fakeDb(rows);
      const order: string[] = [];
      const publish: OutboxPublish = (_subject, _payload, opts) => {
        fake.notePublished(opts.msgId);
        order.push(opts.msgId);
        return Promise.resolve(undefined);
      };

      const fiber = yield* Effect.fork(
        // @ts-expect-error -- fakeDb.db implements only the subset of the drizzle surface the relay uses
        outboxRelay(fake.db, table, publish, { pollIntervalMs: 100, batchSize: 50 }),
      );

      for (let i = 0; i < 5; i++) {
        yield* TestClock.adjust(Duration.millis(100));
        yield* Effect.yieldNow();
      }
      yield* Fiber.interrupt(fiber);

      expect(order).toEqual(["e1", "e2", "e3"]);
      for (const row of rows) {
        // sentAt must come from the TestClock, not wall-clock Date.now(): the TestClock
        // epoch never exceeds the ~500ms we advance here, whereas a `new Date()`
        // implementation would land at the real epoch (~1.7e12) and blow past this bound.
        expect(row.sentAt).not.toBeNull();
        expect(row.sentAt!.getTime()).toBeLessThanOrEqual(1_000);
      }
    }),
  );

  it.effect("leaves sentAt null and re-publishes when publish fails", () =>
    Effect.gen(function* () {
      const rows: Row[] = [
        { id: "1", subject: "s", payload: {}, eventId: "ok", traceparent: null, createdAt: 1, sentAt: null },
        { id: "2", subject: "s", payload: {}, eventId: "boom", traceparent: null, createdAt: 2, sentAt: null },
      ];
      const fake = fakeDb(rows);
      const order: string[] = [];
      const publish: OutboxPublish = (_subject, _payload, opts) => {
        fake.notePublished(opts.msgId);
        order.push(opts.msgId);
        return opts.msgId === "boom"
          ? Promise.reject(new Error("nats down"))
          : Promise.resolve(undefined);
      };

      const fiber = yield* Effect.fork(
        // @ts-expect-error -- fakeDb.db implements only the subset of the drizzle surface the relay uses
        outboxRelay(fake.db, table, publish, { pollIntervalMs: 100, batchSize: 50 }),
      );
      for (let i = 0; i < 5; i++) {
        yield* TestClock.adjust(Duration.millis(100));
        yield* Effect.yieldNow();
      }
      yield* Fiber.interrupt(fiber);

      expect(rows.find((r) => r.eventId === "ok")?.sentAt).not.toBeNull();
      expect(rows.find((r) => r.eventId === "boom")?.sentAt).toBeNull();
      expect(order.filter((id) => id === "boom").length).toBeGreaterThan(1);
    }),
  );
});
