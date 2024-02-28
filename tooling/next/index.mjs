/** @type {import("next").NextConfig} */
export const nextConfig = {
  output: "standalone",
  swcMinify: true,
  poweredByHeader: false,

  reactStrictMode: true,

  /** Enables hot reloading for local packages without a build step */
  transpilePackages: [
    "@tix/api",
    "@tix/auth",
    "@tix/db",
    "@tix/logger",
    "@tix/trpc",
    "@tix/ui",
    "@tix/validators",
  ],

  /** We already do linting and type-checking as separate tasks in CI */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};
