import { z } from "zod";

const ticketIdSchema = z.string();

export const returnTicketSchema = z.object({
  id: ticketIdSchema,
  name: z.string(),
  price: z.number(),
});

export const createTicketSchema = z.object({
  name: z.string().min(1),
  price: z.number().min(1),
});

export const updateTicketSchema = z.object({
  id: ticketIdSchema,
  name: z.string().min(1).optional(),
  price: z.number().min(1).optional(),
});

export const ticketIdInputSchema = z.object({
  id: ticketIdSchema,
});
