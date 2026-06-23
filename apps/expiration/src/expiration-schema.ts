import { pgSchema } from "drizzle-orm/pg-core";

import { defineInbox } from "@tix/db-core/schema";

export const expirationSchema = pgSchema("expiration");

export const expirationInbox = defineInbox(expirationSchema);

export const expirationTables = { inbox: expirationInbox };
