import { generateOpenApiDocument } from "trpc-openapi";

import { authRouter } from "./router/auth";
import { postRouter } from "./router/post";
import { ticketRouter } from "./router/ticket";
import { userRouter } from "./router/user";
import { createTRPCRouter } from "./trpc";

import pkg from "../package.json";

const BASE_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export const appRouter = createTRPCRouter({
  post: postRouter,
  auth: authRouter,
  user: userRouter,
  ticket: ticketRouter,
});

export const openApiDocument = generateOpenApiDocument(appRouter, {
  title: "tix tRPC OpenAPI",
  version: pkg.version,
  baseUrl: `${BASE_URL}/api`,
  tags: ["user", "ticket", "order", "payment"],
});

// export type definition of API
export type AppRouter = typeof appRouter;
