import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: "dist",
    target: "chrome120",
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, "src/background.ts"),
        manager: resolve(import.meta.dirname, "manager.html"),
        settings: resolve(import.meta.dirname, "settings.html")
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
