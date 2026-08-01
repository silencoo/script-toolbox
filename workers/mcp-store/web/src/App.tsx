import { useEffect, useRef, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { toast } from "sonner"

import { AppHeader } from "@/components/app-header"
import { StoreWorkspace } from "@/components/store-workspace"
import { UnlockView } from "@/components/unlock-view"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PROTOCOLS, parseRecoveryCode } from "@/lib/store-crypto.js"
import {
  SECTION_META,
  SECTION_ORDER,
  apiFor,
  downloadFor,
  loadSection,
  protocolType,
  safeMessage,
  validateWorkspaceSnapshot,
} from "@/lib/store-client.js"
import type {
  AppState,
  Protocol,
  RemoteConfig,
  SectionType,
  StoreSession,
  WorkspaceSnapshot,
} from "@/lib/types"

const initialState: AppState = {
  mode: null,
  workspaceConfig: null,
  workspaceSnapshot: null,
  workspaceVersion: null,
  sections: {},
  activeType: "mcp",
}

const TAB_RECOVERY_CODE_KEY = "toolbox-store-recovery-code"

function readTabRecoveryCode() {
  try {
    return window.sessionStorage.getItem(TAB_RECOVERY_CODE_KEY) || ""
  } catch {
    return ""
  }
}

function rememberTabRecoveryCode(recoveryCode: string) {
  try {
    window.sessionStorage.setItem(TAB_RECOVERY_CODE_KEY, recoveryCode)
    return true
  } catch {
    return false
  }
}

function forgetTabRecoveryCode() {
  try {
    window.sessionStorage.removeItem(TAB_RECOVERY_CODE_KEY)
  } catch {
    // The browser may deny storage access; the in-memory session is still cleared below.
  }
}

function SessionRestoreView() {
  return (
    <main
      id="main"
      className="grid min-h-[calc(100svh-3.5rem)] place-items-center px-4"
      aria-busy="true"
      aria-label="Restoring this tab's Store session"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>Restoring this tab’s Store session…</span>
      </div>
    </main>
  )
}

export function App() {
  const [state, setState] = useState<AppState>(initialState)
  const [confirmLock, setConfirmLock] = useState(false)
  const [restoringSession, setRestoringSession] = useState(true)
  const restorePromise = useRef<Promise<void> | null>(null)
  const connected = state.mode !== null
  const hasDirtySession = Object.values(state.sections).some((session) => session?.dirty)

  useEffect(() => {
    const recoveryCode = readTabRecoveryCode()
    if (!recoveryCode) {
      setRestoringSession(false)
      return
    }

    let active = true
    restorePromise.current ??= unlock(recoveryCode, false)
    void restorePromise.current
      .catch((error) => {
        if (!active) return
        forgetTabRecoveryCode()
        toast.error(`This tab’s saved session could not be restored. ${safeMessage(error)}`)
      })
      .finally(() => {
        if (active) setRestoringSession(false)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!hasDirtySession) return

    const confirmDiscard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", confirmDiscard)
    return () => window.removeEventListener("beforeunload", confirmDiscard)
  }, [hasDirtySession])

  async function unlock(recoveryCode: string, remember = true) {
    const parsed = parseRecoveryCode(recoveryCode) as {
      config: RemoteConfig
      protocol: Protocol
    }
    const nextState = parsed.protocol === PROTOCOLS.workspace
      ? await unlockWorkspace(parsed.config)
      : await unlockIsolated(parsed.config, parsed.protocol)
    setState(nextState)
    if (remember && !rememberTabRecoveryCode(recoveryCode)) {
      toast.warning("Unlocked, but this browser blocked tab storage. Refreshing will require the recovery code again.")
    }
  }

  async function unlockWorkspace(config: RemoteConfig): Promise<AppState> {
    const sectionOrder = SECTION_ORDER as SectionType[]
    const status = await apiFor(config, PROTOCOLS.workspace, "") as {
      latest?: { version: string }
    }
    if (!status.latest) throw new Error("This Workspace has no encrypted manifest.")

    const workspaceSnapshot = validateWorkspaceSnapshot(
      await downloadFor(config, PROTOCOLS.workspace),
      config,
    ) as WorkspaceSnapshot
    const sections: Partial<Record<SectionType, StoreSession>> = {}

    await Promise.all(sectionOrder.map(async (type) => {
      const attachment = workspaceSnapshot.stores[type]
      if (!attachment) return
      try {
        sections[type] = await loadSection(
          type,
          attachment.config,
          SECTION_META[type].protocol,
        ) as StoreSession
      } catch (error) {
        sections[type] = {
          type,
          config: attachment.config,
          protocol: SECTION_META[type].protocol,
          error: safeMessage(error),
          snapshot: null,
          version: null,
          dirty: false,
          selectedCollection: "",
          selectedItem: "",
        } as StoreSession
      }
    }))

    const activeType: SectionType = sectionOrder.find((type) => sections[type]?.snapshot) ||
      sectionOrder.find((type) => workspaceSnapshot.stores[type]) ||
      "mcp"

    return {
      mode: "workspace",
      workspaceConfig: config,
      workspaceSnapshot,
      workspaceVersion: status.latest.version,
      sections,
      activeType,
    }
  }

  async function unlockIsolated(config: RemoteConfig, protocol: Protocol): Promise<AppState> {
    const type = protocolType(protocol) as SectionType
    if (!type) throw new Error("This recovery code uses an unsupported Store protocol.")
    const session = await loadSection(type, config, protocol) as StoreSession
    return {
      ...initialState,
      mode: "isolated",
      sections: { [type]: session },
      activeType: type,
    }
  }

  function requestLock() {
    if (hasDirtySession) setConfirmLock(true)
    else lockNow()
  }

  function lockNow() {
    forgetTabRecoveryCode()
    setConfirmLock(false)
    setState(initialState)
  }

  const connectionLabel = restoringSession
    ? "Restoring session"
    : !connected
    ? "Locked"
    : state.mode === "workspace"
      ? "Workspace connected"
      : "Isolated Store connected"

  return (
    <div className="min-h-svh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only z-[100] rounded-md bg-background px-3 py-2 text-sm shadow focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <AppHeader connected={connected} connectionLabel={connectionLabel} />
      {restoringSession ? (
        <SessionRestoreView />
      ) : connected ? (
        <StoreWorkspace state={state} setState={setState} onLock={requestLock} />
      ) : (
        <UnlockView onUnlock={unlock} />
      )}

      <AlertDialog open={confirmLock} onOpenChange={setConfirmLock}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard local changes and lock?</AlertDialogTitle>
            <AlertDialogDescription>
              Unsaved edits exist only in this tab. Locking now removes the decrypted state from memory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={lockNow}>Discard and lock</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
