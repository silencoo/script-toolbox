import { useEffect, useState } from "react"
import { Check, Clock3, Download, LoaderCircle } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import {
  apiFor,
  downloadFor,
  formatBytes,
  safeMessage,
  validateSnapshot,
} from "@/lib/store-client.js"
import type { StoreSession, StoreSnapshot, VersionMetadata } from "@/lib/types"

interface VersionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: StoreSession
  onLoad: (snapshot: StoreSnapshot, version: string) => void
}

export function VersionsDialog({
  open,
  onOpenChange,
  session,
  onLoad,
}: VersionsDialogProps) {
  const [versions, setVersions] = useState<VersionMetadata[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [loadingVersion, setLoadingVersion] = useState("")

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError("")
    void apiFor(session.config, session.protocol, "/versions?limit=100")
      .then((page: { versions?: VersionMetadata[] }) => {
        if (!cancelled) setVersions(page.versions || [])
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(safeMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, session.config, session.protocol, session.version])

  async function loadVersion(version: string) {
    setLoadingVersion(version)
    try {
      const snapshot = validateSnapshot(
        session.protocol,
        await downloadFor(session.config, session.protocol, version),
      ) as StoreSnapshot
      onLoad(snapshot, version)
      onOpenChange(false)
      toast.success("Version loaded into this tab.")
    } catch (caught) {
      toast.error(safeMessage(caught))
    } finally {
      setLoadingVersion("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80svh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Encrypted versions</DialogTitle>
          <DialogDescription>
            Load an immutable backup into this tab. Nothing changes remotely until you save.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 max-h-[60svh] overflow-y-auto border-t px-4">
          {loading && (
            <div className="space-y-3 py-4" aria-label="Loading versions">
              {[0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full" />)}
            </div>
          )}
          {!loading && error && (
            <div className="py-8 text-center">
              <p className="text-sm font-medium">Versions could not be loaded</p>
              <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            </div>
          )}
          {!loading && !error && versions.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">No versions found.</div>
          )}
          {!loading && !error && versions.map((version) => {
            const current = version.version === session.version
            return (
              <div key={version.version} className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Clock3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <p className="truncate text-sm font-medium">
                      {new Date(version.created_at).toLocaleString()}
                    </p>
                    {current && <Badge variant="secondary"><Check />Current</Badge>}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {formatBytes(version.size)} · {version.version.slice(-8)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={Boolean(loadingVersion)}
                  onClick={() => void loadVersion(version.version)}
                >
                  {loadingVersion === version.version
                    ? <LoaderCircle className="animate-spin" />
                    : <Download />}
                  Load
                </Button>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
