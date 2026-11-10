import {
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react"
import {
  Boxes,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

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
import { Textarea } from "@/components/ui/textarea"
import {
  safeMessage,
  saveEncryptedWorkspace,
} from "@/lib/store-client.js"
import type {
  AppState,
  DevelopmentPreset,
  WorkspaceView,
} from "@/lib/types"

interface PresetWorkspaceProps {
  state: AppState
  setState: Dispatch<SetStateAction<AppState>>
  onLock: () => void
  onViewChange: (view: WorkspaceView) => void
}

interface Catalogs {
  mcp: string[]
  skills: string[]
  prompt: string[]
}

const FIELD_META = {
  mcp: { label: "MCP profile", empty: "Attach and load an MCP Store first." },
  skills: { label: "Skills pack", empty: "Attach and load a Skills Store first." },
  prompt: { label: "Prompt profile", empty: "Attach and load a Prompts Store first." },
} as const

export function PresetWorkspace({
  state,
  setState,
  onLock,
  onViewChange,
}: PresetWorkspaceProps) {
  const presets = state.workspaceSnapshot?.presets || {}
  const presetNames = Object.keys(presets).sort()
  const [selectedName, setSelectedName] = useState(presetNames[0] || "")
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const selected = presets[selectedName]
  const catalogs = availableCatalogs(state)
  const missing = selected ? missingReferences(selected, catalogs) : []

  function mutatePreset(name: string, mutator: (preset: DevelopmentPreset) => void) {
    setState((current) => {
      const snapshot = current.workspaceSnapshot
      const existing = snapshot?.presets[name]
      if (!snapshot || !existing) return current
      const nextPreset = { ...existing }
      mutator(nextPreset)
      return {
        ...current,
        workspaceSnapshot: {
          ...snapshot,
          updated_at: new Date().toISOString(),
          presets: { ...snapshot.presets, [name]: nextPreset },
        },
        workspaceDirty: true,
      }
    })
  }

  function createPreset(name: string, description: string) {
    const preset: DevelopmentPreset = {
      schema: 2,
      name,
      description,
      mcp: catalogs.mcp[0],
      skills: catalogs.skills[0],
      prompt: catalogs.prompt[0],
    }
    setState((current) => {
      const snapshot = current.workspaceSnapshot
      if (!snapshot) return current
      return {
        ...current,
        workspaceSnapshot: {
          ...snapshot,
          updated_at: new Date().toISOString(),
          presets: { ...snapshot.presets, [name]: preset },
        },
        workspaceDirty: true,
      }
    })
    setSelectedName(name)
  }

  function deletePreset() {
    if (!selectedName) return
    const remaining = presetNames.filter((name) => name !== selectedName)
    setState((current) => {
      const snapshot = current.workspaceSnapshot
      if (!snapshot?.presets[selectedName]) return current
      const nextPresets = { ...snapshot.presets }
      delete nextPresets[selectedName]
      return {
        ...current,
        workspaceSnapshot: {
          ...snapshot,
          updated_at: new Date().toISOString(),
          presets: nextPresets,
        },
        workspaceDirty: true,
      }
    })
    setSelectedName(remaining[0] || "")
    setDeleteOpen(false)
  }

  async function save() {
    const config = state.workspaceConfig
    const snapshot = state.workspaceSnapshot
    if (!config || !snapshot) return
    const invalid = Object.values(snapshot.presets)
      .map((preset) => ({ preset, missing: missingReferences(preset, catalogs) }))
      .find((entry) => entry.missing.length)
    if (invalid) {
      toast.error(`Preset “${invalid.preset.name}” has unavailable references: ${invalid.missing.join(", ")}.`)
      return
    }
    setSaving(true)
    try {
      const version = await saveEncryptedWorkspace(
        config,
        snapshot,
        state.workspaceVersion,
      ) as string
      setState((current) => ({
        ...current,
        workspaceVersion: version,
        workspaceDirty: current.workspaceSnapshot === snapshot
          ? false
          : current.workspaceDirty,
      }))
      toast.success("Encrypted Workspace saved.")
    } catch (caught) {
      toast.error(safeMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <main
      id="main"
      aria-label="Development preset configuration"
      className="mx-auto min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <WorkspaceTabs state={state} value="presets" onValueChange={onViewChange} />
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus />
            New preset
          </Button>
          <Button type="button" variant="outline" onClick={onLock}>
            <LockKeyhole />
            Lock
          </Button>
        </div>
      </div>

      {state.workspaceDirty && (
        <Alert className="mt-4 border-foreground/20 bg-muted/50">
          <Save />
          <AlertTitle>Preset changes are not backed up</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Save a new encrypted Workspace version before pulling these presets locally.</span>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {saving ? "Saving…" : "Save encrypted Workspace"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(260px,.65fr)_minmax(0,1.35fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle>Development presets</CardTitle>
            <CardDescription>{presetNames.length} saved combination{presetNames.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {presetNames.length === 0 ? (
              <div className="grid min-h-64 place-items-center p-8 text-center">
                <div className="max-w-xs">
                  <Layers3 className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">No presets yet</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Combine one profile or pack from each connected Store.
                  </p>
                  <Button type="button" size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
                    <Plus />Create preset
                  </Button>
                </div>
              </div>
            ) : presetNames.map((name) => {
              const preset = presets[name]
              const errors = missingReferences(preset, catalogs)
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedName(name)}
                  aria-pressed={selectedName === name}
                  className={`block w-full border-b px-4 py-3.5 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    selectedName === name ? "bg-muted" : "hover:bg-muted/50"
                  }`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{name}</span>
                    <Badge variant={errors.length ? "destructive" : "secondary"}>
                      {errors.length ? "Needs attention" : "Ready"}
                    </Badge>
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {preset.description || `${preset.mcp} · ${preset.skills} · ${preset.prompt}`}
                  </span>
                </button>
              )
            })}
          </CardContent>
        </Card>

        {selected ? (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
              <div className="min-w-0">
                <CardTitle className="truncate">{selected.name}</CardTitle>
                <CardDescription>Names are immutable; delete and recreate a preset to rename it.</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setDeleteOpen(true)}
                aria-label={`Delete preset ${selected.name}`}
              >
                <Trash2 />
              </Button>
            </CardHeader>
            <CardContent className="space-y-5 p-5">
              {missing.length > 0 && (
                <Alert variant="destructive">
                  <Boxes />
                  <AlertTitle>Unavailable references</AlertTitle>
                  <AlertDescription>
                    Choose an available value for: {missing.join(", ")}.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="preset-description">Description</Label>
                <Textarea
                  id="preset-description"
                  value={selected.description}
                  onChange={(event) => {
                    const value = event.target.value.slice(0, 500)
                    mutatePreset(selected.name, (preset) => {
                      preset.description = value
                    })
                  }}
                  rows={3}
                  maxLength={500}
                  placeholder="When this development environment should be used"
                />
                <p className="text-right text-xs text-muted-foreground">{selected.description.length}/500</p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {(["mcp", "skills", "prompt"] as const).map((field) => (
                  <PresetSelect
                    key={field}
                    field={field}
                    value={selected[field]}
                    options={catalogs[field]}
                    onChange={(value) => mutatePreset(selected.name, (preset) => {
                      preset[field] = value
                    })}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="grid min-h-80 place-items-center p-8 text-center">
              <div>
                <Layers3 className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium">Select or create a preset</p>
                <p className="mt-1 text-xs text-muted-foreground">Each preset configures all three local control tools together.</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Apply on a development machine</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              The browser edits encrypted definitions only. Pull them, then review and apply locally.
            </p>
          </div>
          <code className="max-w-full overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs whitespace-nowrap">
            agentctl preset pull --yes
          </code>
        </CardContent>
      </Card>

      <CreatePresetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={presetNames}
        catalogs={catalogs}
        onCreate={createPreset}
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{selectedName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the preset from pending Workspace changes. The current encrypted version remains unchanged until you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deletePreset}>Delete preset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

function PresetSelect({
  field,
  value,
  options,
  onChange,
}: {
  field: keyof Catalogs
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  const missing = Boolean(value) && !options.includes(value)
  const selectable = missing ? [value, ...options] : options
  return (
    <div className="space-y-2">
      <Label>{FIELD_META[field].label}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={!selectable.length}>
        <SelectTrigger className="w-full" aria-invalid={missing || undefined}>
          <SelectValue placeholder="Unavailable" />
        </SelectTrigger>
        <SelectContent>
          {selectable.map((name) => (
            <SelectItem key={name} value={name}>
              {name}{name === value && missing ? " (missing)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {options.length === 0 && (
        <p className="text-xs leading-5 text-destructive">{FIELD_META[field].empty}</p>
      )}
    </div>
  )
}

function CreatePresetDialog({
  open,
  onOpenChange,
  existingNames,
  catalogs,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingNames: string[]
  catalogs: Catalogs
  onCreate: (name: string, description: string) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState("")

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
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) || normalized.length > 64) {
      setError("Use at most 64 lowercase letters, numbers, and single hyphens.")
      return
    }
    if (existingNames.includes(normalized)) {
      setError("That preset already exists.")
      return
    }
    const unavailable = (Object.keys(catalogs) as Array<keyof Catalogs>)
      .filter((field) => catalogs[field].length === 0)
      .map((field) => FIELD_META[field].label)
    if (unavailable.length) {
      setError(`Load the missing sources first: ${unavailable.join(", ")}.`)
      return
    }
    onCreate(normalized, description.trim())
    changeOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Create development preset</DialogTitle>
            <DialogDescription>
              Start with the first available profile or pack from each connected Store.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="backend-debugging"
                autoComplete="off"
                maxLength={64}
                aria-invalid={Boolean(error)}
                required
              />
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and single hyphens.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-preset-description">Description</Label>
              <Textarea
                id="new-preset-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                maxLength={500}
                placeholder="When this preset should be applied"
              />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit"><Plus />Create preset</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function availableCatalogs(state: AppState): Catalogs {
  const mcp = state.sections.mcp
  const skills = state.sections.skills
  const prompts = state.sections.prompts
  return {
    mcp: mcp?.type === "mcp" && mcp.snapshot
      ? Object.keys(mcp.snapshot.profiles).sort()
      : [],
    skills: skills?.type === "skills" && skills.snapshot
      ? Object.keys(skills.snapshot.packs).sort()
      : [],
    prompt: prompts?.type === "prompts" && prompts.snapshot
      ? Object.keys(prompts.snapshot.profiles).sort()
      : [],
  }
}

function missingReferences(preset: DevelopmentPreset, catalogs: Catalogs) {
  return (Object.keys(catalogs) as Array<keyof Catalogs>)
    .filter((field) => !catalogs[field].includes(preset[field]))
    .map((field) => FIELD_META[field].label)
}
