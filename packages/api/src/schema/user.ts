import { z } from "zod";

const emailSchema = z.string().email();
const userNameSchema = z.string().min(4).max(25);
const passwordSchema = z.string().min(6);

export const loginUserSchema = z.object({
  username: userNameSchema,
  password: passwordSchema,
});

export const registerUserSchema = z.object({
  email: emailSchema,
  username: userNameSchema,
  password: passwordSchema,
});

export const returnUserSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  token: z.string().optional(),
});

export const returnCurrentUserSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  tickets: z.array(z.any()),
  orders: z.array(z.any()),
});
