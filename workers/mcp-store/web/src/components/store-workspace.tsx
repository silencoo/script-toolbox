import {
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react"
import {
  Box,
  Clock3,
  Download,
  FileJson,
  FileText,
  FolderPlus,
  Import,
  LoaderCircle,
  LockKeyhole,
  PackageOpen,
  Plus,
  Save,
  Search,
  Server,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"

import { StoreInspector, type MutateSession } from "@/components/store-inspector"
import { PresetWorkspace } from "@/components/preset-workspace"
import { VersionsDialog } from "@/components/versions-dialog"
import { WorkspaceTabs } from "@/components/workspace-tabs"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  mergeRedactedMcpImport,
  redactMcpSnapshot,
  resolveMcpProfile,
  setMcpServerEnabled,
} from "@/lib/mcp-model.js"
import {
  SECTION_META,
  WORKSPACE_VIEW_ORDER,
  collectionNamesFor,
  resolvePack,
  safeMessage,
  saveEncryptedSession,
  validateSnapshot,
} from "@/lib/store-client.js"
import type {
  AppState,
  PromptClient,
  SectionType,
  SelectableCollection,
  StoreSession,
  StoreSnapshot,
  WorkspaceView,
} from "@/lib/types"

interface StoreWorkspaceProps {
  state: AppState
  setState: Dispatch<SetStateAction<AppState>>
  onLock: () => void
}

interface CatalogItem {
  description?: string
  transport?: string
  present?: boolean
}

export function StoreWorkspace({ state, setState, onLock }: StoreWorkspaceProps) {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState("name")
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const session = state.activeView === "presets"
    ? undefined
    : state.sections[state.activeView]

  function updateActiveSession(
    mutator: (next: StoreSession) => void,
    { dirty = false }: { dirty?: boolean } = {},
  ) {
    setState((current) => {
      const active = current.activeView
      if (active === "presets") return current
      const existing = current.sections[active]
      if (!existing) return current
      const next = { ...existing } as StoreSession
      mutator(next)
      if (dirty && next.snapshot) {
        next.snapshot.created_at = new Date().toISOString()
        next.dirty = true
      }
      return {
        ...current,
        sections: { ...current.sections, [active]: next },
      }
    })
  }

  const mutateSession: MutateSession = (mutator) => {
    updateActiveSession(mutator, { dirty: true })
  }

  function changeSection(value: WorkspaceView) {
    if (!WORKSPACE_VIEW_ORDER.includes(value)) return
    setQuery("")
    setState((current) => ({ ...current, activeView: value }))
  }

  if (state.mode === "workspace" && state.activeView === "presets") {
    return (
      <PresetWorkspace
        state={state}
        setState={setState}
        onLock={onLock}
        onViewChange={changeSection}
      />
    )
  }

  if (!session?.snapshot) {
    const type = state.activeView as SectionType
    return (
      <main id="main" className="mx-auto min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <WorkspaceTabs state={state} value={state.activeView} onValueChange={changeSection} />
        <UnavailableState state={state} type={type} session={session} onLock={onLock} />
      </main>
    )
  }

  const loadedSession = session

  const names = collectionNamesFor(session.protocol, session.snapshot) as string[]
  const selectedCollection = names.includes(session.selectedCollection)
    ? session.selectedCollection
    : names[0] || ""
  const enabled = resolvedItems(session, selectedCollection)
  const allItems = catalogEntries(session, selectedCollection)
  const entries = allItems
    .filter(([name, item]) =>
      `${name} ${item.description || ""}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort(([nameA, itemA], [nameB, itemB]) => {
      if (sort === "description") {
        return (itemA.description || "").localeCompare(itemB.description || "") ||
          nameA.localeCompare(nameB)
      }
      if (sort === "enabled") {
        return Number(enabled.has(nameB)) - Number(enabled.has(nameA)) ||
          nameA.localeCompare(nameB)
      }
      return nameA.localeCompare(nameB)
    })
  const skills = session.type === "skills"
  const prompts = session.type === "prompts"

  function selectCollection(value: string) {
    updateActiveSession((next) => {
      next.selectedCollection = value
      next.selectedItem = next.type === "prompts" ? "claude" : ""
    })
  }

  function selectItem(name: string) {
    updateActiveSession((next) => {
      next.selectedItem = name
    })
  }

  function toggleItem(name: string, currentlyEnabled: boolean) {
    mutateSession((next) => {
      if (!next.snapshot || !selectedCollection) return
      if (next.type === "skills") {
        const pack = next.snapshot.packs[selectedCollection]
        pack.enable = (pack.enable || []).filter((value) => value !== name)
        pack.disable = (pack.disable || []).filter((value) => value !== name)
        ;(currentlyEnabled ? pack.disable : pack.enable).push(name)
        pack.enable.sort()
        pack.disable.sort()
      } else if (next.type === "mcp") {
        setMcpServerEnabled(next.snapshot, selectedCollection, name, !currentlyEnabled)
      }
    })
  }

  function addItem() {
    if (loadedSession.type !== "prompts") {
      toast.info(
        loadedSession.type === "skills"
          ? "Import a skillsctl JSON snapshot to add complete skill folders."
          : "Import an mcpctl JSON snapshot to add complete server definitions.",
      )
      fileInput.current?.click()
      return
    }
    if (!selectedCollection) {
      toast.error("Create a prompt profile first.")
      return
    }
    const documents = loadedSession.snapshot!.profiles[selectedCollection].documents
    const client = (["claude", "codex"] as PromptClient[]).find((name) => !documents[name]) ||
      (loadedSession.selectedItem as PromptClient) || "claude"
    selectItem(client)
  }

  async function save() {
    setSaving(true)
    try {
      const version = await saveEncryptedSession(loadedSession) as string
      updateActiveSession((next) => {
        next.version = version
        next.dirty = false
      })
      toast.success("Encrypted backup saved.")
    } catch (caught) {
      toast.error(safeMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  function exportSnapshot() {
    const exported = loadedSession.type === "mcp"
      ? redactMcpSnapshot(loadedSession.snapshot)
      : { snapshot: loadedSession.snapshot, redactedCount: 0 }
    const data = JSON.stringify(exported.snapshot, null, 2) + "\n"
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }))
    const link = document.createElement("a")
    const prefix = loadedSession.type === "skills" ? "skillsctl" : loadedSession.type === "prompts" ? "promptctl" : "mcpctl"
    link.href = url
    link.download = `${prefix}-snapshot-${loadedSession.type === "mcp" ? "redacted-" : ""}${new Date().toISOString().slice(0, 10)}.json`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    if (loadedSession.type === "mcp") {
      toast.success(`Redacted snapshot exported; ${exported.redactedCount} Secret value(s) omitted.`)
    } else {
      toast.warning("Plaintext snapshot exported. Store it carefully.")
    }
  }

  async function importSnapshot(file: File | undefined) {
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Snapshot exceeds the 25 MB browser import limit.")
      return
    }
    try {
      let snapshot = JSON.parse(await file.text()) as StoreSnapshot
      let redacted = false
      let preservedCount = 0
      if (loadedSession.type === "mcp") {
        const merged = mergeRedactedMcpImport(snapshot, loadedSession.snapshot)
        snapshot = merged.snapshot as StoreSnapshot
        redacted = merged.redacted
        preservedCount = merged.preservedCount
      }
      validateSnapshot(loadedSession.protocol, snapshot)
      const nextCollection = collectionNamesFor(loadedSession.protocol, snapshot)[0] || ""
      mutateSession((next) => {
        next.snapshot = snapshot as never
        next.selectedCollection = nextCollection
        next.selectedItem = next.type === "prompts" ? "claude" : ""
      })
      toast.success(redacted
        ? `Redacted snapshot imported; ${preservedCount} existing Secret value(s) preserved.`
        : "Plaintext snapshot imported into this tab.")
    } catch (caught) {
      toast.error(safeMessage(caught))
    }
  }

  function loadVersion(snapshot: StoreSnapshot, version: string) {
    updateActiveSession((next) => {
      next.snapshot = snapshot as never
      next.selectedCollection = collectionNamesFor(next.protocol, snapshot)[0] || ""
      next.selectedItem = next.type === "prompts" ? "claude" : ""
      next.dirty = version !== next.version
    })
  }

  return (
    <main
      id="main"
      aria-label={`${SECTION_META[session.type].label} configuration`}
      className="mx-auto min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <WorkspaceTabs state={state} value={state.activeView} onValueChange={changeSection} />
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setVersionsOpen(true)}>
            <Clock3 />
            Versions
          </Button>
          <Button type="button" variant="outline" onClick={onLock}>
            <LockKeyhole />
            Lock
          </Button>
        </div>
      </div>

      {session.dirty && (
        <Alert className="mt-4 border-foreground/20 bg-muted/50">
          <Save />
          <AlertTitle>Local changes are not backed up</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>The decrypted edits exist only in this browser tab.</span>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {saving ? "Saving…" : "Save encrypted backup"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card className="mt-4">
        <CardContent className="grid gap-3 p-4 md:grid-cols-[minmax(220px,1fr)_180px_220px_auto]">
          <div className="space-y-2">
            <Label htmlFor="catalog-search" className="text-xs">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="catalog-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or description"
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Sort</Label>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="description">Description</SelectItem>
                <SelectItem value="enabled">Enabled first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">{skills ? "Pack" : "Profile"}</Label>
            <Select value={selectedCollection || undefined} onValueChange={selectCollection} disabled={!names.length}>
              <SelectTrigger className="w-full"><SelectValue placeholder={`No ${skills ? "pack" : "profile"}`} /></SelectTrigger>
              <SelectContent>
                {names.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 md:justify-end">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
              <FolderPlus />
              New
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setDeleteOpen(true)}
              disabled={!selectedCollection}
              aria-label={`Delete ${skills ? "pack" : "profile"}`}
            >
              <Trash2 />
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,.75fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between border-b">
            <div>
              <CardTitle>{skills ? "Skills catalog" : prompts ? "Client documents" : "MCP catalog"}</CardTitle>
              <CardDescription>{entries.length} of {allItems.length} items</CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addItem}>
              <Plus />
              {prompts ? "Add document" : skills ? "Import skill" : "Add server"}
            </Button>
          </CardHeader>
          <CardContent className="max-h-[640px] overflow-y-auto p-0">
            {entries.length === 0 ? (
              <div className="grid min-h-52 place-items-center p-8 text-center">
                <div>
                  <PackageOpen className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">No matching items</p>
                  <p className="mt-1 text-xs text-muted-foreground">Change the search or choose another collection.</p>
                </div>
              </div>
            ) : entries.map(([name, item]) => (
              <CatalogRow
                key={name}
                name={name}
                item={item}
                type={session.type}
                enabled={enabled.has(name)}
                selected={session.selectedItem === name}
                onSelect={() => selectItem(name)}
                onToggle={() => toggleItem(name, enabled.has(name))}
                toggleDisabled={!selectedCollection}
              />
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden lg:sticky lg:top-4">
          <StoreInspector session={session} enabled={enabled} mutateSession={mutateSession} />
        </Card>
      </div>

      <Card className="mt-4">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted">
              <FileJson className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium">Portable snapshots</p>
              <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
                {session.type === "mcp"
                  ? "Export catalog and profiles with Secret values removed. Encrypted versions remain complete."
                  : "Export a decrypted JSON copy or import one into this tab before backing it up."}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                void importSnapshot(event.target.files?.[0])
                event.target.value = ""
              }}
            />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <Import />
              Import JSON
            </Button>
            <Button type="button" variant="outline" onClick={exportSnapshot}>
              <Download />
              {session.type === "mcp" ? "Export redacted JSON" : "Export JSON"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <CollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        session={session}
        mutateSession={mutateSession}
      />
      <DeleteCollectionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        session={session}
        collection={selectedCollection}
        mutateSession={mutateSession}
      />
      <VersionsDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        session={session}
        onLoad={loadVersion}
      />
    </main>
  )
}

function CatalogRow({
  name,
  item,
  type,
  enabled,
  selected,
  onSelect,
  onToggle,
  toggleDisabled,
}: {
  name: string
  item: CatalogItem
  type: SectionType
  enabled: boolean
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  toggleDisabled: boolean
}) {
  const Icon = type === "mcp" ? Server : type === "skills" ? Wrench : FileText
  const title = type === "prompts" ? (name === "claude" ? "Claude Code" : "Codex") : name
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] items-center border-b last:border-b-0 ${selected ? "bg-muted" : "hover:bg-muted/50"}`}>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 items-center gap-3 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-pressed={selected}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.description || item.transport || "No description"}
          </span>
        </span>
      </button>
      <div className="pr-4">
        {type === "prompts" ? (
          <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? "Ready" : "New"}</Badge>
        ) : (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={toggleDisabled}
            aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
          />
        )}
      </div>
    </div>
  )
}

function CollectionDialog({
  open,
  onOpenChange,
  session,
  mutateSession,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: StoreSession
  mutateSession: MutateSession
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState("")
  const noun = session.type === "skills" ? "pack" : session.type === "prompts" ? "prompt profile" : "profile"

  function changeOpen(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setName("")
      setDescription("")
      setError("")
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = name.trim()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
      setError("Use lowercase letters, numbers, and single hyphens.")
      return
    }
    const collections = session.type === "skills"
      ? session.snapshot?.packs
      : session.snapshot?.profiles
    if (collections?.[normalized]) {
      setError("That name already exists.")
      return
    }
    mutateSession((next) => {
      if (!next.snapshot) return
      const copy = description.trim() || `${normalized} ${noun}`
      if (next.type === "skills") {
        next.snapshot.packs[normalized] = makeSelectableCollection(normalized, copy)
      } else if (next.type === "prompts") {
        next.snapshot.profiles[normalized] = {
          schema: 1,
          name: normalized,
          description: copy,
          documents: {},
        }
      } else {
        next.snapshot.profiles[normalized] = makeSelectableCollection(normalized, copy)
      }
      next.selectedCollection = normalized
      next.selectedItem = next.type === "prompts" ? "claude" : ""
    })
    changeOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Create {noun}</DialogTitle>
            <DialogDescription>Add a focused collection to this encrypted snapshot.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="collection-name">Name</Label>
              <Input
                id="collection-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="frontend-research"
                autoComplete="off"
                aria-invalid={Boolean(error)}
                required
              />
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and single hyphens.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="collection-description">Description</Label>
              <Textarea
                id="collection-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="When this collection should be used"
              />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit"><Plus />Create {noun}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteCollectionDialog({
  open,
  onOpenChange,
  session,
  collection,
  mutateSession,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: StoreSession
  collection: string
  mutateSession: MutateSession
}) {
  const noun = session.type === "skills" ? "pack" : "profile"

  function remove() {
    const collections = session.type === "skills" ? session.snapshot?.packs : session.snapshot?.profiles
    if (!collections || !collection) return
    if (session.type !== "prompts" && Object.keys(collections).length === 1) {
      toast.error(`Keep at least one ${noun} in the Store.`)
      return
    }
    if (session.type === "skills" && session.snapshot) {
      const dependents = Object.values(session.snapshot.packs).filter((pack) =>
        (pack.extends || []).includes(collection),
      )
      if (dependents.length) {
        toast.error(`Cannot delete: ${dependents.map((pack) => pack.name).join(", ")} extends this pack.`)
        return
      }
    }
    mutateSession((next) => {
      if (!next.snapshot) return
      const nextCollections = next.type === "skills" ? next.snapshot.packs : next.snapshot.profiles
      delete nextCollections[collection]
      next.selectedCollection = Object.keys(nextCollections).sort()[0] || ""
      next.selectedItem = next.type === "prompts" ? "claude" : ""
    })
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{collection}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the {noun} from the pending snapshot. The current encrypted backup remains unchanged until you save.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={remove}>Delete {noun}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function UnavailableState({
  state,
  type,
  session,
  onLock,
}: {
  state: AppState
  type: SectionType
  session: StoreSession | undefined
  onLock: () => void
}) {
  const attached = Boolean(state.workspaceSnapshot?.stores[type])
  return (
    <Card className="mt-6 border-dashed">
      <CardContent className="grid min-h-80 place-items-center p-8 text-center">
        <div className="max-w-lg">
          <span className="mx-auto grid size-11 place-items-center rounded-xl border bg-muted">
            <Box className="size-5" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {attached ? `${SECTION_META[type].label} could not be opened` : `Connect ${SECTION_META[type].label}`}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {attached
              ? session?.error || "The encrypted child Store could not be loaded."
              : "Attach an existing isolated Store. Its recovery code remains valid as a break-glass option."}
          </p>
          <code className="mt-4 inline-block rounded-md border bg-muted px-3 py-2 text-xs">
            agentctl workspace attach {type}
          </code>
          <div className="mt-5"><Button type="button" variant="outline" onClick={onLock}>Lock Workspace</Button></div>
        </div>
      </CardContent>
    </Card>
  )
}

function resolvedItems(session: StoreSession, collection: string) {
  if (!session.snapshot || !collection) return new Set<string>()
  if (session.type === "mcp") {
    return resolveMcpProfile(session.snapshot, collection) as Set<string>
  }
  if (session.type === "skills") {
    return resolvePack(session.snapshot, collection) as Set<string>
  }
  return new Set(Object.keys(session.snapshot.profiles[collection]?.documents || {}))
}

function catalogEntries(session: StoreSession, collection: string): Array<[string, CatalogItem]> {
  if (!session.snapshot) return []
  if (session.type === "mcp") {
    return Object.entries(session.snapshot.catalog.servers)
  }
  if (session.type === "skills") {
    return Object.entries(session.snapshot.catalog.skills)
  }
  const documents = session.snapshot.profiles[collection]?.documents || {}
  return [
    ["claude", {
      description: documents.claude ? "CLAUDE.md persistent instructions" : "Create Claude Code instructions",
      present: Boolean(documents.claude),
    }],
    ["codex", {
      description: documents.codex ? "config.toml model instructions" : "Create Codex instructions",
      present: Boolean(documents.codex),
    }],
  ]
}

function makeSelectableCollection(name: string, description: string): SelectableCollection {
  return {
    schema: 1,
    name,
    description,
    extends: [],
    enable: [],
    disable: [],
    target_overrides: {},
  }
}
