export type AriaTaskStatus =
  | "active"
  | "waiting"
  | "paused"
  | "error"
  | "complete"
  | "removed";

export interface AriaUri {
  status: "used" | "waiting";
  uri: string;
}

export interface AriaFile {
  completedLength: string;
  index: string;
  length: string;
  path: string;
  selected: "true" | "false";
  uris: AriaUri[];
}

export interface AriaTask {
  bitfield?: string;
  bittorrent?: {
    announceList?: string[][];
    comment?: string;
    creationDate?: number;
    info?: { name?: string };
    mode?: "single" | "multi";
  };
  completedLength: string;
  connections?: string;
  dir: string;
  downloadSpeed: string;
  errorCode?: string;
  errorMessage?: string;
  files: AriaFile[];
  gid: string;
  infoHash?: string;
  numSeeders?: string;
  followedBy?: string[];
  following?: string;
  seeder?: "true" | "false";
  status: AriaTaskStatus;
  totalLength: string;
  uploadLength: string;
  uploadSpeed: string;
  verifiedLength?: string;
  verifyIntegrityPending?: "true" | "false";
}

export interface AriaGlobalStat {
  downloadSpeed: string;
  numActive: string;
  numStopped: string;
  numStoppedTotal: string;
  numWaiting: string;
  uploadSpeed: string;
}

export interface AriaVersion {
  enabledFeatures: string[];
  version: string;
}

export interface DownloadSnapshot {
  active: AriaTask[];
  capturedAt: number;
  global: AriaGlobalStat;
  stopped: AriaTask[];
  waiting: AriaTask[];
}

export interface PublicSettings {
  addPaused: boolean;
  configured: boolean;
  defaultDirectory: string;
  endpoint: string;
  maxResults: number;
  notifications: boolean;
  refreshInterval: number;
  rememberSecret: boolean;
}

export type SecretStatus = "missing" | "session" | "persistent";

export interface ConnectionInfo {
  secretStatus: SecretStatus;
  settings: PublicSettings;
}

export interface AddUriRequest {
  directory?: string;
  headers?: string[];
  out?: string;
  pause?: boolean;
  referer?: string;
  uris: string[];
}

export interface AddMetafileRequest {
  base64: string;
  directory?: string;
  fileName: string;
  pause?: boolean;
}

export type TaskControlAction =
  | "pause"
  | "resume"
  | "remove"
  | "forget"
  | "retry";

export type GlobalControlAction = "pauseAll" | "resumeAll" | "purgeResults";

export type ExtensionRequest =
  | { type: "connection:get" }
  | {
      endpoint: string;
      secret?: string;
      type: "connection:test";
      useStoredSecret: boolean;
    }
  | {
      secret?: string;
      settings: PublicSettings;
      type: "connection:save";
      useStoredSecret: boolean;
    }
  | { type: "connection:reset" }
  | { type: "snapshot:get" }
  | { gid: string; type: "task:get" }
  | { request: AddUriRequest; type: "task:addUris" }
  | { request: AddMetafileRequest; type: "task:addMetafile" }
  | { action: TaskControlAction; gid: string; type: "task:control" }
  | { action: GlobalControlAction; type: "global:control" }
  | { type: "manager:openTab" };

export interface ExtensionSuccess<T = unknown> {
  data: T;
  ok: true;
}

export interface ExtensionFailure {
  code: string;
  message: string;
  ok: false;
}

export type ExtensionResponse<T = unknown> = ExtensionSuccess<T> | ExtensionFailure;
