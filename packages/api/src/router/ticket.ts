import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

/**
 * /api/tickets - GET
 * /api/tickets/:id - GET
 * /api/tickets - POST, title: string, price: string
 * /api/tickets/:id - PUT, title: string, price string
 */

export const ticketRouter = createTRPCRouter({
  all: publicProcedure.query(({ ctx }) => {
    // TODO: dont return tickets that have an order status of created, payment, or completed
    return ctx.prisma.ticket.findMany({ orderBy: { id: "desc" } });
  }),
  byId: publicProcedure.input(z.string()).query(({ ctx, input }) => {
    return ctx.prisma.ticket.findFirst({ where: { id: input } });
  }),
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        price: z.number().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      const userId = ctx.session.user.id;

      return ctx.prisma.ticket.create({ data: { ...input, userId } });
    }),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        price: z.number().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { id, ...data } = input;

      const ticket = await ctx.prisma.ticket.findUnique({
        where: { id },
      });

      if (!ticket) {
        throw new TRPCError({
          code: "NOT_FOUND",
        });
      }

      if (ticket.userId !== userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      }

      return ctx.prisma.ticket.update({ where: { id }, data });
    }),
  delete: protectedProcedure
    .input(z.string())
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const ticket = await ctx.prisma.ticket.findUnique({
        where: { id: input },
      });

      if (!ticket) {
        throw new TRPCError({
          code: "NOT_FOUND",
        });
      }

      if (ticket.userId !== userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      }

      return ctx.prisma.ticket.delete({ where: { id: input } });
    }),
});
