import { useState, type FormEvent } from "react"
import { Clipboard, FileText, PackageOpen, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"

import type { MutateSession } from "@/components/store-inspector"
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
import { Textarea } from "@/components/ui/textarea"
import {
  createPromptSnippet,
  deletePromptSnippet,
  setPromptSnippetContent,
  snippetNames,
  validSnippetName,
} from "@/lib/prompt-model.js"
import { formatBytes } from "@/lib/store-client.js"
import type { PromptsSession } from "@/lib/types"

const MAX_SNIPPET_BYTES = 1024 * 1024

function contentBytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export function SnippetWorkspace({
  session,
  mutateSession,
}: {
  session: PromptsSession
  mutateSession: MutateSession
}) {
  const [query, setQuery] = useState("")
  const [selectedName, setSelectedName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const snapshot = session.snapshot
  if (!snapshot) return null

  const names = snippetNames(snapshot)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredNames = names.filter((name) => name.toLowerCase().includes(normalizedQuery))
  const selected = filteredNames.includes(selectedName)
    ? selectedName
    : filteredNames[0] || ""
  const snippet = selected ? snapshot.snippets[selected] : null
  const bytes = snippet ? contentBytes(snippet.content) : 0
  const oversized = bytes > MAX_SNIPPET_BYTES

  function create(name: string) {
    mutateSession((next) => {
      if (next.type !== "prompts" || !next.snapshot) return
      createPromptSnippet(next.snapshot, name)
    })
    setQuery("")
    setSelectedName(name)
  }

  function remove() {
    if (!selected) return
    const remaining = names.filter((name) => name !== selected)
    mutateSession((next) => {
      if (next.type !== "prompts" || !next.snapshot) return
      deletePromptSnippet(next.snapshot, selected)
    })
    setSelectedName(remaining[0] || "")
    setDeleteOpen(false)
  }

  async function copy() {
    if (!snippet) return
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser.")
      }
      await navigator.clipboard.writeText(snippet.content)
      toast.success(`Copied “${selected}” to the clipboard.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Snippet could not be copied.")
    }
  }

  return (
    <section className="mt-4" aria-labelledby="snippets-heading">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="w-full max-w-xl space-y-2">
            <Label htmlFor="snippet-search" className="text-xs">Search snippets</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="snippet-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name"
                className="pl-9"
              />
            </div>
          </div>
          <Button type="button" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus />
            New snippet
          </Button>
        </CardContent>
      </Card>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(280px,.65fr)_minmax(0,1.35fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <CardTitle id="snippets-heading">Snippet library</CardTitle>
            <CardDescription>{filteredNames.length} of {names.length} snippets</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[640px] overflow-y-auto p-0" aria-label="Saved snippets">
            {names.length === 0 ? (
              <div className="grid min-h-64 place-items-center p-8 text-center">
                <div className="max-w-xs">
                  <PackageOpen className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">No snippets yet</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Add a reusable prompt that you want available without automatically loading it into an agent.
                  </p>
                  <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
                    <Plus />Create first snippet
                  </Button>
                </div>
              </div>
            ) : filteredNames.length === 0 ? (
              <div className="grid min-h-52 place-items-center p-8 text-center">
                <div>
                  <Search className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">No matching snippets</p>
                  <Button type="button" variant="link" size="sm" onClick={() => setQuery("")}>Clear search</Button>
                </div>
              </div>
            ) : filteredNames.map((name) => {
              const item = snapshot.snippets[name]
              const itemBytes = contentBytes(item.content)
              const active = name === selected
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setSelectedName(name)}
                  className={`flex w-full items-center gap-3 border-b px-4 py-3.5 text-left outline-none last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${active ? "bg-muted" : ""}`}
                  aria-pressed={active}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background">
                    <FileText className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{formatBytes(itemBytes)}</span>
                  </span>
                  <Badge variant={item.content ? "secondary" : "outline"}>{item.content ? "Ready" : "Empty"}</Badge>
                </button>
              )
            })}
          </CardContent>
        </Card>

        <Card className="overflow-hidden lg:sticky lg:top-4">
          {snippet ? (
            <>
              <CardHeader className="flex flex-col gap-3 border-b sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Snippet editor</p>
                  <CardTitle className="mt-1 truncate">{selected}</CardTitle>
                  <CardDescription className="mt-1">Names are immutable; create another snippet to rename it.</CardDescription>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void copy()} disabled={!snippet.content}>
                    <Clipboard />Copy
                  </Button>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setDeleteOpen(true)} aria-label={`Delete ${selected}`}>
                    <Trash2 />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 p-5">
                <Label htmlFor="snippet-editor">Reusable prompt</Label>
                <Textarea
                  id="snippet-editor"
                  value={snippet.content}
                  onChange={(event) => {
                    const content = event.target.value
                    mutateSession((next) => {
                      if (next.type !== "prompts" || !next.snapshot) return
                      setPromptSnippetContent(next.snapshot, selected, content)
                    })
                  }}
                  rows={18}
                  spellCheck={false}
                  aria-invalid={oversized}
                  aria-describedby="snippet-editor-help snippet-editor-size"
                  placeholder="Write the reusable prompt you want to copy on demand."
                  className="min-h-80 resize-y font-mono text-xs leading-6"
                />
                <div className="flex flex-col gap-1 text-xs leading-5 sm:flex-row sm:items-center sm:justify-between">
                  <p id="snippet-editor-help" className="text-muted-foreground">
                    Saved end-to-end encrypted. Run promptctl restore to sync WebUI edits to the local library.
                  </p>
                  <p id="snippet-editor-size" className={oversized ? "font-medium text-destructive" : "text-muted-foreground"}>
                    {formatBytes(bytes)} / 1 MB
                  </p>
                </div>
                {oversized && (
                  <p className="text-sm text-destructive" role="alert">
                    Shorten this snippet before saving the encrypted backup.
                  </p>
                )}
              </CardContent>
            </>
          ) : (
            <div className="grid min-h-80 place-items-center p-8 text-center">
              <div>
                <FileText className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium">No snippet selected</p>
                <p className="mt-1 text-xs text-muted-foreground">Create a snippet to open the editor.</p>
              </div>
            </div>
          )}
        </Card>
      </div>

      <CreateSnippetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={names}
        onCreate={create}
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{selected}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the snippet from pending changes. The current encrypted backup remains recoverable until you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete snippet</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function CreateSnippetDialog({
  open,
  onOpenChange,
  existingNames,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingNames: string[]
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState("")
  const [error, setError] = useState("")

  function changeOpen(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setName("")
      setError("")
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = name.trim()
    if (!validSnippetName(normalized)) {
      setError("Use up to 64 lowercase letters, numbers, and single hyphens.")
      return
    }
    if (existingNames.includes(normalized)) {
      setError("That snippet already exists.")
      return
    }
    onCreate(normalized)
    changeOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Create snippet</DialogTitle>
            <DialogDescription>Add a reusable prompt to this encrypted Prompt Store.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="snippet-name">Name</Label>
            <Input
              id="snippet-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError("")
              }}
              placeholder="review-code"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby="snippet-name-help snippet-name-error"
              required
            />
            <p id="snippet-name-help" className="text-xs text-muted-foreground">
              Lowercase letters, numbers, and single hyphens. Names cannot be changed later.
            </p>
            {error && <p id="snippet-name-error" className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit"><Plus />Create snippet</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
