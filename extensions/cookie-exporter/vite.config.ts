import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: "dist",
    target: "chrome119",
    rollupOptions: {
      input: "popup.html"
    }
  }
});
