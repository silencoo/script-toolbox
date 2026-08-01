import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SECTION_META, WORKSPACE_VIEW_ORDER } from "@/lib/store-client.js"
import type { AppState, WorkspaceView } from "@/lib/types"

const VIEW_LABELS: Record<WorkspaceView, string> = {
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
          visible.length === 1 ? "grid-cols-1 sm:max-w-72" : "grid-cols-2 sm:grid-cols-4"
        }`}
      >
        {visible.map((type) => {
          const session = type === "presets" ? undefined : state.sections[type]
          const attached = type === "presets" || state.mode !== "workspace" ||
            Boolean(state.workspaceSnapshot?.stores[type])
          const dirty = type === "presets" ? state.workspaceDirty : session?.dirty
          const status = dirty
            ? "Unsaved"
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
