import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

const emailSchema = z.string().email();
const userNameSchema = z.string().min(4).max(25);
const passwordSchema = z.string().min(6);

export const userRouter = createTRPCRouter({
  //   all: publicProcedure.query(({ ctx }) => {
  //     return ctx.prisma.post.findMany({ orderBy: { id: "desc" } });
  //   }),
  //   byId: publicProcedure.input(z.string()).query(({ ctx, input }) => {
  //     return ctx.prisma.post.findFirst({ where: { id: input } });
  //   }),
  //   create: publicProcedure
  //     .input(z.object({ title: z.string().min(1), content: z.string().min(1) }))
  //     .mutation(({ ctx, input }) => {
  //       return ctx.prisma.post.create({ data: input });
  //     }),
  //   delete: publicProcedure.input(z.string()).mutation(({ ctx, input }) => {
  //     return ctx.prisma.post.delete({ where: { id: input } });
  //   }),
  current: protectedProcedure.mutation(({ ctx }) => {}),
  login: publicProcedure
    .input(
      z.object({
        username: userNameSchema,
        password: passwordSchema,
      }),
    )
    .mutation(({ ctx, input }) => {
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
        expires: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      };
    }),
  logout: protectedProcedure.mutation(({ ctx }) => {}),
  register: publicProcedure
    .input(
      z.object({
        email: emailSchema,
        username: userNameSchema,
        password: passwordSchema,
      }),
    )
    .mutation(({ ctx, input }) => {}),
});
