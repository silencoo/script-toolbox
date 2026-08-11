import {
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react"
import {
  BadgeDollarSign,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Route,
  Save,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import { WorkspaceTabs } from "@/components/workspace-tabs"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  safeMessage,
  saveEncryptedWorkspace,
  validateWorkspaceSnapshot,
} from "@/lib/store-client.js"
import type {
  AgentWorkspaceBundle,
  AppState,
  WorkspaceView,
} from "@/lib/types"

interface AgentWorkspaceProps {
  state: AppState
  setState: Dispatch<SetStateAction<AppState>>
  onLock: () => void
  onViewChange: (view: WorkspaceView) => void
}

type AgentSurface = "profiles" | "secrets" | "failover" | "pricing"
type JsonField = "providers" | "failover" | "pricing"

function formatted(value: unknown) {
  return value === null ? "" : JSON.stringify(value, null, 2)
}

function emptyAgentBundle(now = new Date().toISOString()): AgentWorkspaceBundle {
  return {
    schema: 1,
    synced_at: now,
    providers: {
      schema: 1,
      kind: "agentctl-provider-store",
      created_at: now,
      updated_at: now,
      profiles: {},
    },
    secrets: {
      schema: 1,
      kind: "agentctl-provider-secrets",
      updated_at: now,
      secrets: {},
    },
    failover: null,
    pricing: null,
  }
}

export function AgentWorkspace({
  state,
  setState,
  onLock,
  onViewChange,
}: AgentWorkspaceProps) {
  const bundle = state.workspaceSnapshot?.agent
  const [surface, setSurface] = useState<AgentSurface>("profiles")
  const [saving, setSaving] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<JsonField, string>>({
    providers: formatted(bundle?.providers),
    failover: formatted(bundle?.failover),
    pricing: formatted(bundle?.pricing),
  })

  useEffect(() => {
    setDrafts({
      providers: formatted(bundle?.providers),
      failover: formatted(bundle?.failover),
      pricing: formatted(bundle?.pricing),
    })
  }, [bundle?.providers, bundle?.failover, bundle?.pricing])

  function replaceSnapshot(nextBundle: AgentWorkspaceBundle) {
    setState((current) => {
      if (!current.workspaceSnapshot) return current
      const now = new Date().toISOString()
      return {
        ...current,
        workspaceSnapshot: {
          ...current.workspaceSnapshot,
          updated_at: now,
          agent: { ...nextBundle, synced_at: now },
        },
        workspaceDirty: true,
      }
    })
  }

  function mutateBundle(mutator: (next: AgentWorkspaceBundle) => void) {
    setState((current) => {
      if (!current.workspaceSnapshot?.agent.providers ||
          !current.workspaceSnapshot.agent.secrets) return current
      const now = new Date().toISOString()
      const next = structuredClone(current.workspaceSnapshot.agent)
      mutator(next)
      next.synced_at = now
      return {
        ...current,
        workspaceSnapshot: {
          ...current.workspaceSnapshot,
          updated_at: now,
          agent: next,
        },
        workspaceDirty: true,
      }
    })
  }

  function initialize() {
    replaceSnapshot(emptyAgentBundle())
    toast.success("Empty Provider and Secret catalogs created in this tab.")
  }

  function applyJson(field: JsonField) {
    const config = state.workspaceConfig
    const snapshot = state.workspaceSnapshot
    if (!config || !snapshot || !bundle) return
    try {
      const raw = drafts[field].trim()
      if (field === "providers" && !raw) throw new Error("Provider Store JSON cannot be empty.")
      const value = raw ? JSON.parse(raw) : null
      const next = structuredClone(snapshot)
      next.updated_at = new Date().toISOString()
      next.agent[field] = value
      next.agent.synced_at = next.updated_at
      validateWorkspaceSnapshot(next, config)
      setState((current) => ({
        ...current,
        workspaceSnapshot: next,
        workspaceDirty: true,
      }))
      setDrafts((current) => ({ ...current, [field]: formatted(value) }))
      toast.success(`${field === "providers" ? "Provider" : field === "failover" ? "Failover" : "Pricing"} JSON applied locally.`)
    } catch (caught) {
      toast.error(safeMessage(caught))
    }
  }

  async function save() {
    const config = state.workspaceConfig
    const snapshot = state.workspaceSnapshot
    if (!config || !snapshot) return
    setSaving(true)
    try {
      validateWorkspaceSnapshot(snapshot, config)
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
      toast.success("Encrypted Provider Workspace saved.")
    } catch (caught) {
      toast.error(safeMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  const profileCount = Object.keys(bundle?.providers?.profiles || {}).length
  const secretNames = Object.keys(bundle?.secrets?.secrets || {}).sort()
  const routeCount = Object.keys(bundle?.failover?.routes || {}).length
  const rateCount = Object.keys(bundle?.pricing?.rates || {}).length

  if (!bundle?.providers || !bundle.secrets) {
    return (
      <main id="main" className="mx-auto min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <WorkspaceTabs state={state} value="providers" onValueChange={onViewChange} />
        <Card className="mt-6 border-dashed">
          <CardContent className="grid min-h-80 place-items-center p-8 text-center">
            <div className="max-w-xl">
              <Database className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
              <h1 className="mt-4 text-xl font-semibold tracking-tight">No Provider bundle backed up</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Push the machine’s existing catalogs, or initialize empty portable catalogs here. Generated client files and proxy runtime state are never part of this bundle.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button type="button" onClick={initialize}><Plus />Initialize empty catalogs</Button>
                <Button type="button" variant="outline" onClick={onLock}><LockKeyhole />Lock</Button>
              </div>
              <code className="mt-5 inline-block rounded-md border bg-muted px-3 py-2 text-xs">
                agentctl workspace agent push --yes
              </code>
            </div>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main
      id="main"
      aria-label="Provider Workspace configuration"
      className="mx-auto min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <WorkspaceTabs state={state} value="providers" onValueChange={onViewChange} />
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={onLock}><LockKeyhole />Lock</Button>
        </div>
      </div>

      {state.workspaceDirty && (
        <Alert className="mt-4 border-foreground/20 bg-muted/50">
          <Save />
          <AlertTitle>Provider changes are not backed up</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Secrets and catalogs are decrypted only in this tab until you save.</span>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {saving ? "Saving…" : "Save encrypted Workspace"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Summary icon={Database} label="Profiles" value={profileCount} detail="portable provider definitions" />
        <Summary icon={KeyRound} label="Secrets" value={secretNames.length} detail="encrypted values · masked below" />
        <Summary icon={Route} label="Failover" value={routeCount} detail="ordered portable routes" />
        <Summary icon={BadgeDollarSign} label="Pricing" value={rateCount} detail={bundle.pricing?.version || "no catalog"} />
      </div>

      <Tabs value={surface} onValueChange={(value) => setSurface(value as AgentSurface)} className="mt-4">
        <TabsList variant="line" aria-label="Provider Workspace content">
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="failover">Failover</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>
      </Tabs>

      {surface === "secrets" ? (
        <Card className="mt-4">
          <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
            <div>
              <CardTitle>Provider Secrets</CardTitle>
              <CardDescription>Values are masked and saved only inside the end-to-end encrypted Workspace payload.</CardDescription>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setSecretOpen(true)}><Plus />New Secret</Button>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {secretNames.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">No provider Secret values are backed up.</p>
            ) : secretNames.map((name) => {
              const secret = bundle.secrets!.secrets[name]
              return (
                <div key={name} className="grid gap-3 p-4 sm:grid-cols-[minmax(180px,.5fr)_minmax(240px,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={`secret-name-${name}`}>Reference</Label>
                    <Input id={`secret-name-${name}`} value={name} readOnly />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`secret-value-${name}`}>Encrypted value</Label>
                    <Input
                      id={`secret-value-${name}`}
                      type="password"
                      autoComplete="new-password"
                      value={secret.value}
                      onChange={(event) => {
                        const value = event.target.value.slice(0, 16384)
                        mutateBundle((next) => {
                          if (!next.secrets?.secrets[name]) return
                          next.secrets.secrets[name] = {
                            value,
                            updated_at: new Date().toISOString(),
                          }
                          next.secrets.updated_at = new Date().toISOString()
                        })
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete Secret ${name}`}
                    onClick={() => mutateBundle((next) => {
                      if (!next.secrets) return
                      delete next.secrets.secrets[name]
                      next.secrets.updated_at = new Date().toISOString()
                    })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
          </CardContent>
        </Card>
      ) : (
        <JsonCatalogEditor
          field={surface === "profiles" ? "providers" : surface}
          value={drafts[surface === "profiles" ? "providers" : surface]}
          onChange={(value) => setDrafts((current) => ({
            ...current,
            [surface === "profiles" ? "providers" : surface]: value,
          }))}
          onApply={() => applyJson(surface === "profiles" ? "providers" : surface)}
        />
      )}

      <Card className="mt-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Restore on another machine</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Pull portable catalogs and encrypted Secrets, then explicitly plan/apply the profile for that machine and OS.
            </p>
          </div>
          <code className="max-w-full overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs whitespace-nowrap">
            agentctl workspace agent pull --replace --yes
          </code>
        </CardContent>
      </Card>

      <NewSecretDialog
        open={secretOpen}
        onOpenChange={setSecretOpen}
        names={secretNames}
        onCreate={(name, value) => mutateBundle((next) => {
          if (!next.secrets) return
          const now = new Date().toISOString()
          next.secrets.secrets[name] = { value, updated_at: now }
          next.secrets.updated_at = now
        })}
      />
    </main>
  )
}

function Summary({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Database
  label: string
  value: number
  detail: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted"><Icon className="size-4" aria-hidden="true" /></span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium">{label}<Badge variant="secondary">{value}</Badge></span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      </CardContent>
    </Card>
  )
}

const CATALOG_META = {
  providers: {
    title: "Portable Provider Store",
    description: "Endpoints, protocols, exact model aliases, target overrides, and Darwin/Linux/Windows overlays. Secret values are stored separately.",
    empty: false,
  },
  failover: {
    title: "Failover policy Store",
    description: "Ordered backend names and circuit policy. Use an empty editor to remove the optional catalog. same_request may duplicate execution and billing.",
    empty: true,
  },
  pricing: {
    title: "Versioned pricing catalog",
    description: "Exact model/profile/effective-time rates with source provenance. Use an empty editor to remove the optional catalog.",
    empty: true,
  },
} as const

function JsonCatalogEditor({
  field,
  value,
  onChange,
  onApply,
}: {
  field: JsonField
  value: string
  onChange: (value: string) => void
  onApply: () => void
}) {
  const meta = CATALOG_META[field]
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
        <div>
          <CardTitle>{meta.title}</CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </div>
        <Button type="button" size="sm" onClick={onApply}>Apply JSON</Button>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        <Label htmlFor={`agent-json-${field}`}>Strict catalog JSON</Label>
        <Textarea
          id={`agent-json-${field}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={22}
          spellCheck={false}
          className="font-mono text-xs leading-5"
          placeholder={meta.empty ? "Optional — leave empty to remove" : "Provider Store JSON"}
        />
        <p className="text-xs text-muted-foreground">
          Applying validates the complete Workspace before any encrypted version can be saved.
        </p>
      </CardContent>
    </Card>
  )
}

function NewSecretDialog({
  open,
  onOpenChange,
  names,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  names: string[]
  onCreate: (name: string, value: string) => void
}) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [error, setError] = useState("")

  function changeOpen(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setName("")
      setValue("")
      setError("")
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reference = name.trim()
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(reference) || reference.includes("..") || reference.length > 96) {
      setError("Use a letter first, followed by letters, numbers, dots, underscores, or hyphens.")
      return
    }
    if (names.includes(reference)) {
      setError("That Secret reference already exists.")
      return
    }
    if (!value || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) {
      setError("Enter a non-empty value without control characters (maximum 16 KiB).")
      return
    }
    onCreate(reference, value)
    changeOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Add Provider Secret</DialogTitle>
            <DialogDescription>The value stays masked and enters only the encrypted Workspace payload.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider-secret-reference">Reference name</Label>
              <Input id="provider-secret-reference" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" placeholder="work_gateway_key" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-secret-new-value">Secret value</Label>
              <Input id="provider-secret-new-value" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" required />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit"><Plus />Add Secret</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
