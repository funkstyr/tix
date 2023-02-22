import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

const route = "/ticket";

export const ticketRouter = createTRPCRouter({
  all: publicProcedure
    .meta({ openapi: { method: "GET", path: `${route}` } })
    .input(z.void())
    .output(
      z.array(
        z.object({ id: z.string(), name: z.string(), price: z.number() }),
      ),
    )
    .query(({ ctx }) => {
      // TODO: dont return tickets that have an order status of created, payment, or completed
      return ctx.prisma.ticket.findMany({ orderBy: { id: "desc" } });
    }),
  byId: publicProcedure
    .meta({ openapi: { method: "GET", path: `${route}/{id}` } })
    .input(z.object({ id: z.string() }))
    .output(
      z
        .object({ id: z.string(), name: z.string(), price: z.number() })
        .nullable(),
    )
    .query(({ ctx, input }) => {
      console.log("getById", input);
      const { id } = input;
      return ctx.prisma.ticket.findFirst({ where: { id } });
    }),
  create: protectedProcedure
    .meta({ openapi: { method: "POST", path: `${route}` } })
    .input(
      z.object({
        name: z.string().min(1),
        price: z.number().min(1),
      }),
    )
    .output(z.object({ id: z.string(), name: z.string(), price: z.number() }))
    .mutation(({ ctx, input }) => {
      const userId = ctx.session.user.id;

      return ctx.prisma.ticket.create({ data: { ...input, userId } });
    }),
  update: protectedProcedure
    .meta({ openapi: { method: "PUT", path: `${route}/{id}` } })
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        price: z.number().min(1).optional(),
      }),
    )
    .output(z.object({ id: z.string(), name: z.string(), price: z.number() }))
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
    .meta({ openapi: { method: "DELETE", path: `${route}/{id}` } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { id } = input;
      const userId = ctx.session.user.id;

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

      return ctx.prisma.ticket.delete({ where: { id } });
    }),
});
