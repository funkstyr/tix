import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  // In the Tilt loop the dev server listens on 80 but is reached via a 5173→80
  // port-forward, so the HMR socket must target the forwarded port. Host dev
  // (`pnpm dev`, already on 5173) leaves this unset and uses Vite's defaults.
  server: process.env.VITE_HMR_CLIENT_PORT
    ? { hmr: { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) } }
    : undefined,
});
