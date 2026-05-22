import { fileURLToPath } from "node:url";

export const migrationsFolder: string = fileURLToPath(new URL("../drizzle", import.meta.url));
