import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createOrderSchema,
  orderIdInputSchema,
  returnOrderSchema,
} from "../schema/order";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const route = "/order";

export const orderRouter = createTRPCRouter({
  all: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: `${route}`,
        tags: ["order"],
        protect: true,
      },
    })
    .input(z.void())
    .output(z.array(returnOrderSchema))
    .query(({ ctx }) => {
      const userId = ctx.session.user.id;

      return ctx.prisma.order.findMany({
        orderBy: { id: "desc" },
        where: {
          userId,
        },
      });
    }),
  byId: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: `${route}/{id}`,
        tags: ["order"],
        protect: true,
      },
    })
    .input(orderIdInputSchema)
    .output(returnOrderSchema.nullable())
    .query(({ ctx, input }) => {
      const { id } = input;
      const userId = ctx.session.user.id;

      return ctx.prisma.order.findFirst({ where: { id, userId } });
    }),
  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: `${route}`,
        tags: ["order"],
        protect: true,
      },
    })
    .input(createOrderSchema)
    .output(returnOrderSchema)
    .mutation(({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // only hold for 15 minute
      const expiresAt = new Date(Date.now() + 1000 * 60 * 15).toISOString();

      return ctx.prisma.order.create({ data: { ...input, userId, expiresAt } });
    }),
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: `${route}/{id}`,
        tags: ["order"],
        protect: true,
      },
    })
    .input(orderIdInputSchema)
    .output(orderIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { id } = input;
      const userId = ctx.session.user.id;

      const order = await ctx.prisma.order.findFirst({
        where: { id, userId },
      });

      if (!order) {
        throw new TRPCError({
          code: "NOT_FOUND",
        });
      }

      if (order.userId !== userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      }

      return ctx.prisma.order.delete({ where: { id } });
    }),
});
