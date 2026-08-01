export type SectionType = "mcp" | "skills" | "prompts"
export type WorkspaceView = SectionType | "presets"
export type WorkspaceMode = "workspace" | "isolated" | null

export interface Protocol {
  id: string
  prefix: string
  authInfo: string
  snapshotInfo: string
  envelopeKind: string
  contentType: string
  baseHeader: string
}

export interface RemoteConfig {
  schema: number
  endpoint: string
  store_id: string
  root_key: string
}

export interface SecretDescriptor {
  secret: string
  env?: string
  required?: boolean
  prefix?: string
  suffix?: string
  header?: string
  type?: string
}

export interface McpDefinition {
  category?: string
  description?: string
  homepage?: string
  provider?: string
  auth_mode?: string
  variant_group?: string
  variant_label?: string
  setup?: string
  transport: "http" | "stdio"
  url?: string
  command?: Array<string | SecretDescriptor>
  auth?: SecretDescriptor
  environment?: Record<string, string | SecretDescriptor>
  headers?: Record<string, string | SecretDescriptor>
  target_overrides?: Record<string, Partial<McpDefinition>>
  supported_targets?: string[]
}

export interface SelectableCollection {
  schema: number
  name: string
  description: string
  extends: string[]
  enable: string[]
  disable: string[]
  target_overrides: Record<string, { enable?: string[]; disable?: string[] }>
  servers?: string[]
  managed_by?: string
}

export interface McpSnapshot {
  schema: number
  created_at: string
  catalog: { schema?: number; servers: Record<string, McpDefinition> }
  profiles: Record<string, SelectableCollection>
  secrets: Record<string, string>
  _toolbox_export?: unknown
}

export interface SkillMetadata {
  description: string
  sha256: string
  [key: string]: unknown
}

export interface SkillsSnapshot {
  schema: number
  kind: "skillsctl-store"
  created_at: string
  catalog: { skills: Record<string, SkillMetadata> }
  skills: Record<string, { files: Record<string, string> }>
  packs: Record<string, SelectableCollection>
}

export type PromptClient = "claude" | "codex"

export interface PromptDocument {
  schema: number
  client: PromptClient
  content: string
  sha256: string
}

export interface PromptProfile {
  schema: number
  name: string
  description: string
  documents: Partial<Record<PromptClient, PromptDocument>>
}

export interface PromptsSnapshot {
  schema: number
  kind: "promptctl-store"
  created_at: string
  profiles: Record<string, PromptProfile>
}

export type StoreSnapshot = McpSnapshot | SkillsSnapshot | PromptsSnapshot

interface SessionBase {
  config: RemoteConfig
  protocol: Protocol
  version: string | null
  dirty: boolean
  selectedCollection: string
  selectedItem: string
  error?: string
}

export interface McpSession extends SessionBase {
  type: "mcp"
  snapshot: McpSnapshot | null
}

export interface SkillsSession extends SessionBase {
  type: "skills"
  snapshot: SkillsSnapshot | null
}

export interface PromptsSession extends SessionBase {
  type: "prompts"
  snapshot: PromptsSnapshot | null
}

export type StoreSession = McpSession | SkillsSession | PromptsSession

export interface WorkspaceAttachment {
  schema: 2
  type: SectionType
  protocol: string
  attached_at: string
  config: RemoteConfig
}

export interface DevelopmentPreset {
  schema: 2
  name: string
  description: string
  mcp: string
  skills: string
  prompt: string
}

export interface WorkspaceSnapshot {
  schema: 2
  kind: "agentctl-workspace"
  name: string
  created_at: string
  updated_at: string
  stores: Partial<Record<SectionType, WorkspaceAttachment>>
  presets: Record<string, DevelopmentPreset>
}

export interface AppState {
  mode: WorkspaceMode
  workspaceConfig: RemoteConfig | null
  workspaceSnapshot: WorkspaceSnapshot | null
  workspaceVersion: string | null
  workspaceDirty: boolean
  sections: Partial<Record<SectionType, StoreSession>>
  activeView: WorkspaceView
}

export interface VersionMetadata {
  version: string
  created_at: string
  size: number
}
