import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  loginUserSchema,
  registerUserSchema,
  returnUserSchema,
} from "../schema/user";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

// TODO: should we do this in protected procedure to always update?
const refreshExpiresAt = () =>
  new Date(Date.now() + 1000 * 60 * 60).toISOString();

const route = "/user";

export const userRouter = createTRPCRouter({
  current: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: `${route}/current`,
        tags: ["user"],
        protect: true,
      },
    })
    .input(z.void())
    .output(returnUserSchema)
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      const currentUser = await ctx.prisma.user.findUnique({
        where: {
          id: userId,
        },
        select: {
          id: true,
          name: true,
          username: true,
          tickets: true,
          orders: true,
        },
      });

      if (!currentUser) {
        throw new TRPCError({
          code: "BAD_REQUEST",
        });
      }

      ctx.session.expires = refreshExpiresAt();

      return currentUser;
    }),
  login: publicProcedure
    .meta({
      openapi: { method: "POST", path: `${route}/login`, tags: ["user"] },
    })
    .input(loginUserSchema)
    .output(returnUserSchema)
    .mutation(async ({ ctx, input }) => {
      const existingUser = await ctx.prisma.user.findUnique({
        where: {
          username: input.username,
        },
      });

      if (!existingUser) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "username or password invalid",
        });
      }

      // const { password, ...userData } = existingUser;

      // TODO: hash passwords
      if (existingUser.password !== input.password) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "username or password invalid",
        });
      }

      ctx.session = {
        user: {
          id: existingUser.id,
        },
        expires: refreshExpiresAt(),
      };

      // TODO: check if output scrubs password
      return existingUser;
    }),
  logout: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: `${route}/logout`,
        tags: ["user"],
        protect: true,
      },
    })
    .input(z.void())
    .output(z.void())
    .mutation(({ ctx }) => {
      // TODO: figure right way to logout
      ctx.session = {
        user: {
          id: "",
        },
        expires: "",
      };
    }),
  register: publicProcedure
    .meta({
      openapi: { method: "POST", path: `${route}/register`, tags: ["user"] },
    })
    .input(registerUserSchema)
    .output(returnUserSchema)
    .mutation(async ({ ctx, input }) => {
      const existingUser = await ctx.prisma.user.findUnique({
        where: {
          username: input.username,
        },
      });

      if (existingUser) {
        throw new TRPCError({
          code: "BAD_REQUEST",
        });
      }

      // TODO: hash password

      return ctx.prisma.user.create({ data: input });
    }),
});
