import { useState } from "react"

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

export function App() {
  const [state, setState] = useState<AppState>(initialState)
  const [confirmLock, setConfirmLock] = useState(false)
  const connected = state.mode !== null
  const hasDirtySession = Object.values(state.sections).some((session) => session?.dirty)

  async function unlock(recoveryCode: string) {
    const parsed = parseRecoveryCode(recoveryCode) as {
      config: RemoteConfig
      protocol: Protocol
    }
    const nextState = parsed.protocol === PROTOCOLS.workspace
      ? await unlockWorkspace(parsed.config)
      : await unlockIsolated(parsed.config, parsed.protocol)
    setState(nextState)
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
    setConfirmLock(false)
    setState(initialState)
  }

  const connectionLabel = !connected
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
      {connected ? (
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
