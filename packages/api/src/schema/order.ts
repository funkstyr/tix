import { z } from "zod";

import { returnTicketSchema } from "./ticket";

export const orderIdInputSchema = z.object({ id: z.string() });

const orderStatusSchema = z.enum([
  "created",
  "cancelled",
  "payment",
  "completed",
]);

export const returnOrderSchema = z.object({
  id: z.string(),
  status: orderStatusSchema,
  expiresAt: z.string().datetime(),

  ticket: returnTicketSchema,
});

export const createOrderSchema = z.object({
  ticketId: z.string(),
});

// todo: do we even allow to update an order? can cancel or add payment
export const updateOrderSchema = z.object({
  id: z.string(),
  status: orderStatusSchema,
});
