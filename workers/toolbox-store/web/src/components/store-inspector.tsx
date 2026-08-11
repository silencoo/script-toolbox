import { useState } from "react"
import {
  BookOpen,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  authModeLabel,
  collectSecretDescriptors,
} from "@/lib/mcp-model.js"
import { safeHttpsUrl } from "@/lib/store-client.js"
import type {
  McpSession,
  PromptClient,
  PromptsSession,
  StoreSession,
} from "@/lib/types"

export type MutateSession = (mutator: (session: StoreSession) => void) => void

interface StoreInspectorProps {
  session: StoreSession
  enabled: Set<string>
  scopeLabel: string
  mutateSession: MutateSession
}

export function StoreInspector({ session, enabled, scopeLabel, mutateSession }: StoreInspectorProps) {
  if (!session.snapshot) return null
  if (session.type === "prompts") {
    return <PromptInspector session={session} mutateSession={mutateSession} />
  }
  if (session.type === "mcp" && session.selectedItem &&
      session.snapshot.catalog.servers[session.selectedItem]) {
    return (
      <McpInspector
        session={session}
        enabled={enabled.has(session.selectedItem)}
        scopeLabel={scopeLabel}
        mutateSession={mutateSession}
      />
    )
  }

  const collection = session.type === "skills"
    ? session.snapshot.packs[session.selectedCollection]
    : session.snapshot.profiles[session.selectedCollection]
  const noun = session.type === "skills" ? "Pack" : "Profile"

  if (!collection) {
    return <EmptyInspector title={`No ${noun.toLowerCase()} selected`} />
  }

  return (
    <div className="space-y-5 p-5">
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{noun} details</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">{collection.name}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {collection.description || `No ${noun.toLowerCase()} description.`}
        </p>
      </div>
      <Separator />
      <dl className="grid gap-4 text-sm">
        {session.type === "skills" && (
          <Detail label="Extends" value={(collection.extends || []).join(", ") || "None"} />
        )}
        <Detail label="Scope" value={scopeLabel} />
        <Detail label="Enabled items" value={String(enabled.size)} />
      </dl>
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Resolved selection</p>
        <div className="flex flex-wrap gap-1.5">
          {[...enabled].sort().map((name) => (
            <Badge key={name} variant="secondary" className="font-mono text-[11px] font-normal">
              {name}
            </Badge>
          ))}
          {enabled.size === 0 && <span className="text-sm text-muted-foreground">Nothing enabled.</span>}
        </div>
      </div>
    </div>
  )
}

function McpInspector({
  session,
  enabled,
  scopeLabel,
  mutateSession,
}: {
  session: McpSession
  enabled: boolean
  scopeLabel: string
  mutateSession: MutateSession
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const snapshot = session.snapshot
  if (!snapshot) return null
  const serverName = session.selectedItem
  const definition = snapshot.catalog.servers[serverName]
  const descriptors = collectSecretDescriptors(definition) as Array<{
    secret: string
    env: string
    required: boolean
    header: string
  }>
  const homepage = safeHttpsUrl(definition.homepage)

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Server details</p>
          <h2 className="mt-1 truncate text-lg font-semibold tracking-tight">{serverName}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {definition.description || "No server description."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{scopeLabel} scope</p>
        </div>
        <Badge variant={enabled ? "default" : "outline"}>
          {enabled ? <CheckCircle2 /> : <Server />}
          {enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      <Separator />
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <Detail label="Provider" value={definition.provider || "—"} />
        <Detail label="Authentication" value={authModeLabel(definition)} />
        <Detail label="Transport" value={definition.transport} />
        <Detail
          label="Endpoint"
          value={definition.url || definition.command?.map(String).join(" ") || "—"}
          mono
        />
      </dl>

      {definition.variant_group && (
        <Alert>
          <ShieldCheck />
          <AlertTitle>Exclusive authentication mode</AlertTitle>
          <AlertDescription>
            Enabling this entry automatically disables the other {definition.variant_group} variants.
          </AlertDescription>
        </Alert>
      )}

      {definition.setup && (
        <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
          {definition.setup}
        </div>
      )}

      {homepage && (
        <Button variant="outline" size="sm" asChild>
          <a href={homepage} target="_blank" rel="noreferrer">
            <BookOpen />
            Provider documentation
            <ExternalLink data-icon="inline-end" />
          </a>
        </Button>
      )}

      <Separator />
      <section aria-labelledby="credentials-title">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          <h3 id="credentials-title" className="text-sm font-medium">
            {descriptors.length === 1 ? "Credential" : "Credentials"}
          </h3>
        </div>

        {descriptors.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm leading-6 text-muted-foreground">
            {definition.auth_mode === "oauth"
              ? "OAuth tokens stay in each MCP client and are never stored in this Workspace. Authenticate again after restoring on a new machine."
              : definition.auth_mode === "keyless"
                ? "This mode needs no account or API key. Its fixed keyless header is already part of the catalog."
                : "This server has no stored credential fields."}
          </div>
        ) : (
          <div className="space-y-4">
            {descriptors.map((descriptor) => {
              const value = snapshot.secrets[descriptor.secret] || ""
              const helpId = `secret-${descriptor.secret}-help`
              return (
                <div key={descriptor.secret} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor={`secret-${descriptor.secret}`} className="font-mono text-xs">
                      {descriptor.secret}
                    </Label>
                    <Badge variant="outline" className="font-normal">
                      {descriptor.required ? "Required" : "Optional"}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id={`secret-${descriptor.secret}`}
                      type={revealed[descriptor.secret] ? "text" : "password"}
                      value={value}
                      onChange={(event) => {
                        const nextValue = event.target.value
                        mutateSession((next) => {
                          if (next.type !== "mcp" || !next.snapshot) return
                          if (nextValue) next.snapshot.secrets[descriptor.secret] = nextValue
                          else delete next.snapshot.secrets[descriptor.secret]
                        })
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder={descriptor.required ? "Required API key" : "Optional API key"}
                      aria-describedby={helpId}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setRevealed((current) => ({
                        ...current,
                        [descriptor.secret]: !current[descriptor.secret],
                      }))}
                      aria-label={`${revealed[descriptor.secret] ? "Hide" : "Show"} ${descriptor.secret}`}
                      aria-pressed={Boolean(revealed[descriptor.secret])}
                    >
                      {revealed[descriptor.secret] ? <EyeOff /> : <Eye />}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => mutateSession((next) => {
                        if (next.type === "mcp" && next.snapshot) {
                          delete next.snapshot.secrets[descriptor.secret]
                        }
                      })}
                      disabled={!value}
                    >
                      Clear
                    </Button>
                  </div>
                  <p id={helpId} className="text-xs leading-5 text-muted-foreground">
                    {value
                      ? "Stored inside the end-to-end encrypted MCP snapshot."
                      : `${descriptor.required ? "Not stored here. " : "Optional. "}${
                        descriptor.env
                          ? `mcpctl can instead read $${descriptor.env} when applying this profile.`
                          : "Add a value before applying this server."
                      }`}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function PromptInspector({
  session,
  mutateSession,
}: {
  session: PromptsSession
  mutateSession: MutateSession
}) {
  const snapshot = session.snapshot
  if (!snapshot) return null
  const profile = snapshot.profiles[session.selectedCollection]
  if (!profile) return <EmptyInspector title="No prompt profile selected" />
  const client: PromptClient = session.selectedItem === "codex" ? "codex" : "claude"
  const document = profile.documents[client]
  const label = client === "claude" ? "Claude Code" : "Codex"

  return (
    <div className="space-y-4 p-5">
      <div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Prompt editor</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">{label}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{profile.description}</p>
      </div>
      <Separator />
      <div className="space-y-2">
        <Label htmlFor="prompt-editor">{label} Markdown</Label>
        <Textarea
          id="prompt-editor"
          value={document?.content || ""}
          onChange={(event) => {
            const content = event.target.value
            mutateSession((next) => {
              if (next.type !== "prompts" || !next.snapshot) return
              next.snapshot.profiles[next.selectedCollection].documents[client] = {
                schema: 1,
                client,
                content,
                sha256: "0".repeat(64),
              }
            })
          }}
          rows={18}
          placeholder="# Persistent instructions\n\nWrite the guidance this agent should keep across sessions."
          className="min-h-80 resize-y font-mono text-xs leading-6"
        />
        <p className="text-xs leading-5 text-muted-foreground">
          Saved end-to-end encrypted. Run promptctl restore to write Web UI edits back to local instruction files.
        </p>
      </div>
      {document && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" size="sm">
              <Trash2 />
              Remove {label} document
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this client document?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the {label} Markdown from the pending snapshot. Save the encrypted backup to make it permanent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => mutateSession((next) => {
                if (next.type === "prompts" && next.snapshot) {
                  delete next.snapshot.profiles[next.selectedCollection].documents[client]
                }
              })}>
                Remove document
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words ${mono ? "font-mono text-xs leading-5" : ""}`}>{value}</dd>
    </div>
  )
}

function EmptyInspector({ title }: { title: string }) {
  return (
    <div className="grid min-h-72 place-items-center p-6 text-center">
      <div>
        <LockKeyhole className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">Choose a collection or catalog item to inspect it.</p>
      </div>
    </div>
  )
}
