import { useState, type FormEvent } from "react"
import { Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface UnlockViewProps {
  onUnlock: (recoveryCode: string) => Promise<void>
}

export function UnlockView({ onUnlock }: UnlockViewProps) {
  const [recoveryCode, setRecoveryCode] = useState("")
  const [visible, setVisible] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError("")
    try {
      await onUnlock(recoveryCode.trim())
      setRecoveryCode("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.slice(0, 300) : "Could not unlock this Store.")
    } finally {
      setPending(false)
    }
  }

  return (
    <main id="main" className="mx-auto grid min-h-[calc(100svh-3.5rem)] w-full max-w-[1200px] items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_460px] lg:px-8">
      <section className="max-w-2xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          End-to-end encrypted workspace
        </div>
        <h1 className="max-w-xl text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-5xl lg:text-6xl">
          One private home for your agent setup.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
          Manage MCP profiles, focused skill packs, and persistent prompts without exposing recovery material to the Worker.
        </p>
        <dl className="mt-10 grid max-w-xl gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
          {[
            ["MCP", "Profiles & credentials"],
            ["Skills", "Focused capability packs"],
            ["Prompts", "Durable instructions"],
          ].map(([term, detail]) => (
            <div key={term} className="bg-background p-4">
              <dt className="text-sm font-medium">{term}</dt>
              <dd className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Card className="border-foreground/15 shadow-sm">
        <CardHeader className="border-b">
          <div className="mb-2 grid size-10 place-items-center rounded-lg border bg-muted">
            <KeyRound className="size-4" aria-hidden="true" />
          </div>
          <CardTitle>Unlock your Store</CardTitle>
          <CardDescription>
            Use the Workspace code or an isolated MCP, Skills, or Prompt recovery code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="recovery-code">Recovery code</Label>
              <div className="relative">
                <Input
                  id="recovery-code"
                  name="recovery-code"
                  type={visible ? "text" : "password"}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="toolbox1_…"
                  className="h-10 pr-10 font-mono text-xs"
                  aria-describedby="recovery-help"
                  aria-invalid={Boolean(error)}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2"
                  onClick={() => setVisible((value) => !value)}
                  aria-label={visible ? "Hide recovery code" : "Show recovery code"}
                  aria-pressed={visible}
                >
                  {visible ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <p id="recovery-help" className="text-xs leading-5 text-muted-foreground">
                The endpoint, Store ID, and encryption root stay in this browser tab.
              </p>
            </div>
            {error && (
              <Alert variant="destructive" role="alert">
                <LockKeyhole />
                <AlertTitle>Unlock failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={pending || !recoveryCode.trim()}>
              {pending ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
              {pending ? "Unlocking…" : "Unlock Store"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
