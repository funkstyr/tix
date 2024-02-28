import { fileURLToPath } from "url";
import _jiti from "jiti";

const jiti = _jiti(fileURLToPath(import.meta.url));

// Import env files to validate at build time. Use jiti so we can load .ts files in here.
jiti("./src/env");
jiti("@tix/auth/env");

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,

  /** Enables hot reloading for local packages without a build step */
  transpilePackages: [
    "@tix/api",
    "@tix/auth",
    "@tix/db",
    "@tix/ui",
    "@tix/validators",
  ],

  /** We already do linting and type-checking as separate tasks in CI */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default config;
