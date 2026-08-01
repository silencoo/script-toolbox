import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/App"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import "@/index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="toolbox-ui-theme">
      <App />
      <Toaster position="bottom-center" closeButton />
    </ThemeProvider>
  </StrictMode>,
)
