import { LockKeyhole, ShieldCheck } from "lucide-react"

import { ModeToggle } from "@/components/mode-toggle"
import { Badge } from "@/components/ui/badge"

interface AppHeaderProps {
  connected: boolean
  connectionLabel: string
}

export function AppHeader({ connected, connectionLabel }: AppHeaderProps) {
  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="/" className="flex items-center gap-2.5 font-medium tracking-tight">
          <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <span>Toolbox Store</span>
        </a>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="hidden gap-1.5 font-normal sm:inline-flex">
            {connected ? (
              <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />
            ) : (
              <LockKeyhole className="size-3" aria-hidden="true" />
            )}
            {connectionLabel}
          </Badge>
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
