export const EXPIRATION_QUEUE = "expiration";
export const EXPIRATION_JOB_NAME = "expire-order";
export const EXPIRATION_CONSUMER_GROUP = "expiration";

// At-least-once publish of order.expired.v1 without a service-local outbox (see #14):
// BullMQ retries the job on failure, and JetStream dedupes via a deterministic msgId
// (`expired:<orderId>`) so a lost ack on attempt N is dropped server-side on attempt N+1.
// expiredAt is carried in the job payload so retries publish byte-identical events.
export const EXPIRATION_JOB_ATTEMPTS = 5;
export const EXPIRATION_JOB_BACKOFF_MS = 200;

// `traceparent` is a trace-context carrier only: the W3C string captured from the
// active span at enqueue (much like the outbox column). The worker reads it to
// continue the originating order's trace but publishes `{ orderId, expiredAt }`
// verbatim, so it never enters the JetStream dedupe msgId and retries stay
// byte-identical. Kept in its own duck so the consumer (enqueue) and the worker
// (dequeue) agree on the shape without importing each other.
export type ExpireOrderPayload = {
  orderId: string;
  expiredAt: string;
  traceparent?: string;
};
