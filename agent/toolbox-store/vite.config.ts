import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(projectRoot, "web"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(projectRoot, "web/src"),
    },
  },
  build: {
    outDir: path.join(projectRoot, "ui"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
})
