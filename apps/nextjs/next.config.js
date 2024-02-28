import { fileURLToPath } from "url";
import _jiti from "jiti";

import { nextConfig } from "@tix/next-config";

const jiti = _jiti(fileURLToPath(import.meta.url));

// Import env files to validate at build time. Use jiti so we can load .ts files in here.
jiti("./src/env");

/** @type {import("next").NextConfig} */
const config = {
  ...nextConfig,
};

export default config;
