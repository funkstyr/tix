import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";

import { db } from "@tix/db";

// TODO: mv this to a trpc pkg
interface Session {
  id: string;
  email: string;
  role: string;
}

export const createTRPCContext = (opts: {
  headers: Headers;
  session: Session | null;
}) => {
  const session = opts.session;
  const source = opts.headers.get("x-trpc-source") ?? "unknown";

  console.log(">>> tRPC Request from", source, "by", session?.id);

  return {
    session,
    db,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
    },
  }),
});

const publicProcedure = t.procedure;

const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      // infers the `session` as non-nullable
      session: { ...ctx.session },
    },
  });
});

const router = t.router;

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
