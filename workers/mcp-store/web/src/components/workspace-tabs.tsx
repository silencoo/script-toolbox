import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SECTION_META, SECTION_ORDER, WORKSPACE_VIEW_ORDER } from "@/lib/store-client.js"
import type { AppState, SectionType, WorkspaceView } from "@/lib/types"

const VIEW_LABELS: Record<WorkspaceView, string> = {
  providers: "Providers",
  mcp: SECTION_META.mcp.label,
  skills: SECTION_META.skills.label,
  prompts: SECTION_META.prompts.label,
  presets: "Presets",
}

export function WorkspaceTabs({
  state,
  value,
  onValueChange,
}: {
  state: AppState
  value: WorkspaceView
  onValueChange: (value: WorkspaceView) => void
}) {
  const visible = state.mode === "workspace"
    ? WORKSPACE_VIEW_ORDER as WorkspaceView[]
    : [state.activeView]

  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as WorkspaceView)}>
      <TabsList
        className={`grid w-full items-stretch gap-1 rounded-xl p-1 group-data-horizontal/tabs:h-auto ${
          visible.length === 1 ? "grid-cols-1 sm:max-w-72" : "grid-cols-2 sm:grid-cols-5"
        }`}
      >
        {visible.map((type) => {
          const section = SECTION_ORDER.includes(type) ? type as SectionType : null
          const session = section ? state.sections[section] : undefined
          const providerBackedUp = Boolean(
            state.workspaceSnapshot?.agent.providers && state.workspaceSnapshot.agent.secrets,
          )
          const attached = type === "providers"
            ? providerBackedUp
            : type === "presets" || state.mode !== "workspace" ||
              Boolean(section && state.workspaceSnapshot?.stores[section])
          const dirty = type === "providers" || type === "presets"
            ? state.workspaceDirty
            : session?.dirty
          const status = dirty
            ? "Unsaved"
            : type === "providers"
              ? providerBackedUp ? "Synced" : "No backup"
              : session?.error
                ? "Unavailable"
                : attached ? "Connected" : "Not attached"
          return (
            <TabsTrigger
              key={type}
              value={type}
              className="h-10 min-w-0 justify-center gap-1 px-2 py-0 leading-none data-[state=inactive]:hover:bg-background/60 sm:justify-between sm:px-3"
            >
              <span className="truncate leading-none">{VIEW_LABELS[type]}</span>
              <span className="hidden shrink-0 text-[10px] leading-none font-normal text-muted-foreground sm:inline">
                {status}
              </span>
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
