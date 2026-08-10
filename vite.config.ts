import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// the renderer is loaded over file://, so assets must be referenced relatively
export default defineConfig({

  root: "swe",
  base: "./",

  plugins: [react(), tailwind()],

  resolve: {

    alias: {

      "@": path.resolve(root, "swe"),

    },

  },

  build: {

    outDir: "dist",
    emptyOutDir: true,

  },

});
