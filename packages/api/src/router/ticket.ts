import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTicketSchema,
  returnTicketSchema,
  ticketIdInputSchema,
  updateTicketSchema,
} from "../schema/ticket";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

const route = "/ticket";

export const ticketRouter = createTRPCRouter({
  all: publicProcedure
    .meta({ openapi: { method: "GET", path: `${route}`, tags: ["ticket"] } })
    .input(z.void())
    .output(z.array(returnTicketSchema))
    .query(({ ctx }) => {
      // TODO: dont return tickets that have an order status of created, payment, or completed
      return ctx.prisma.ticket.findMany({ orderBy: { id: "desc" } });
    }),
  byId: publicProcedure
    .meta({
      openapi: { method: "GET", path: `${route}/{id}`, tags: ["ticket"] },
    })
    .input(ticketIdInputSchema)
    .output(returnTicketSchema.nullable())
    .query(({ ctx, input }) => {
      const { id } = input;
      return ctx.prisma.ticket.findFirst({ where: { id } });
    }),
  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: `${route}`,
        tags: ["ticket"],
        protect: true,
      },
    })
    .input(createTicketSchema)
    .output(returnTicketSchema)
    .mutation(({ ctx, input }) => {
      const userId = ctx.session.user.id;

      return ctx.prisma.ticket.create({ data: { ...input, userId } });
    }),
  update: protectedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: `${route}/{id}`,
        tags: ["ticket"],
        protect: true,
      },
    })
    .input(updateTicketSchema)
    .output(returnTicketSchema)
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
    .meta({
      openapi: {
        method: "DELETE",
        path: `${route}/{id}`,
        tags: ["ticket"],
        protect: true,
      },
    })
    .input(ticketIdInputSchema)
    .output(ticketIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { id } = input;
      const userId = ctx.session.user.id;

      // TODO: eventually make this a soft delete

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
