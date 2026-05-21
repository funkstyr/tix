import { expect, test } from "vitest";

import {
  ORDER_CREATED_V1,
  ORDER_EXPIRED_V1,
  ORDER_RESERVATION_RELEASED_V1,
  TICKETS_CREATED_V1,
} from "./subjects";

test("subjects carry the documented .v1 suffix", () => {
  expect(TICKETS_CREATED_V1).toBe("tickets.created.v1");
  expect(ORDER_CREATED_V1).toBe("order.created.v1");
  expect(ORDER_EXPIRED_V1).toBe("order.expired.v1");
  expect(ORDER_RESERVATION_RELEASED_V1).toBe("order.reservation_released.v1");
});
