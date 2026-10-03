import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({

  root,
  plugins: [react(), tailwindcss()],

  build: {

    outDir: "dist",
    emptyOutDir: true,

  },

  // `bun run pts:dev` against a server on the default port; ws covers /api/ws
  server: {

    proxy: {

      "/api": { target: "http://localhost:7420", ws: true },

    },

  },

});
