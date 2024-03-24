import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, publicProcedure, router } from "@tix/trpc";

const $auth = z.object({
  email: z.string().min(6, "email is required").email("must be email"),
  password: z.string().min(6, "password must be 6 characters"),
});

export const authRouter = router({
  me: protectedProcedure.query(({ ctx, input }) => {
    // query db user info
    // return info
  }),

  signUp: publicProcedure.input($auth).mutation(({ ctx, input }) => {
    // find user by email
    // if user exists, return error
    throw new TRPCError({
      code: "BAD_REQUEST",
    });
    // hash password
    // save to db
  }),

  signIn: publicProcedure.input($auth).mutation(({ ctx, input }) => {
    // find user by email
    // if no user, return error
    throw new TRPCError({
      code: "BAD_REQUEST",
    });
  }),

  signOut: publicProcedure.mutation(({ ctx, input }) => {
    // not empty
  }),

  // TODO: add refresh endpoint
});

export type AppRouter = typeof authRouter;
