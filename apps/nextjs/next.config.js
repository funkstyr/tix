import { fileURLToPath } from "url";
import { nextConfig } from "@tix/next-config";
import _jiti from "jiti";

const jiti = _jiti(fileURLToPath(import.meta.url));

// Import env files to validate at build time. Use jiti so we can load .ts files in here.
jiti("./src/env");

/** @type {import("next").NextConfig} */
const config = {
  ...nextConfig,
};

export default config;
