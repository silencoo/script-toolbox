import type { AriaTask, ConnectionInfo, DownloadSnapshot, ExtensionRequest, ExtensionResponse } from "./types";

const localData: Record<string, unknown> = {};
const sessionData: Record<string, unknown> = {};
const listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void> = [];

const connection: ConnectionInfo = {
  secretStatus: "session",
  settings: {
    addPaused: false,
    configured: true,
    defaultDirectory: "/Users/haerin/Downloads",
    endpoint: "http://127.0.0.1:6800/jsonrpc",
    maxResults: 100,
    notifications: false,
    refreshInterval: 2_000,
    rememberSecret: false
  }
};

const tasks: AriaTask[] = [
  makeTask({
    completedLength: "2750000000",
    connections: "8",
    downloadSpeed: "18400000",
    files: [makeFile("/Users/haerin/Downloads/Design.Archive.2026.zip", "8000000000", "2750000000", "https://cdn.example.com/design-archive.zip")],
    gid: "8a74f92d1e3c4b5a",
    status: "active",
    totalLength: "8000000000"
  }),
  makeTask({
    bittorrent: { info: { name: "Open Source Film Collection" }, mode: "multi" },
    completedLength: "42100000000",
    downloadSpeed: "6200000",
    files: [makeFile("/Users/haerin/Downloads/Open Source Film Collection/feature.mkv", "68400000000", "42100000000", "magnet:?xt=urn:btih:123")],
    gid: "19b5e80fc2a7643d",
    infoHash: "c779e64a04db9eac0c84b66eb6de54a36f2c3f38",
    numSeeders: "21",
    status: "active",
    totalLength: "68400000000"
  }),
  makeTask({
    completedLength: "1250000000",
    files: [makeFile("/Users/haerin/Downloads/Reference-Pack.tar.zst", "4900000000", "1250000000", "https://mirror.example.org/reference.tar.zst")],
    gid: "7de11a4f9c845a20",
    status: "paused",
    totalLength: "4900000000"
  }),
  makeTask({
    completedLength: "184000000",
    files: [makeFile("/Users/haerin/Downloads/aria2-1.37.0.tar.xz", "184000000", "184000000", "https://github.com/aria2/aria2/releases/download/1.37.0/aria2.tar.xz")],
    gid: "b7c89d203a1e45f6",
    status: "complete",
    totalLength: "184000000"
  }),
  makeTask({
    completedLength: "0",
    errorCode: "3",
    errorMessage: "Resource not found",
    files: [makeFile("/Users/haerin/Downloads/expired-link.bin", "0", "0", "https://example.com/expired.bin")],
    gid: "e0a19b24d6c75f38",
    status: "error",
    totalLength: "0"
  })
];

export function installDevChromeMock(): void {
  const mockChrome = {
    permissions: {
      remove: async () => true,
      request: async () => true
    },
    runtime: {
      getURL: (path: string) => new URL(path, location.href).toString(),
      id: "aria-relay-dev-preview",
      openOptionsPage: async () => undefined,
      sendMessage: async (request: ExtensionRequest): Promise<ExtensionResponse> =>
        handleRequest(request)
    },
    storage: {
      local: createStorageArea(localData, "local"),
      onChanged: { addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.push(listener) },
      session: createStorageArea(sessionData, "session")
    }
  };

  if (typeof chrome === "undefined") {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: mockChrome,
      writable: true
    });
  } else {
    Object.assign(chrome, mockChrome);
  }
}

function handleRequest(request: ExtensionRequest): ExtensionResponse {
  switch (request.type) {
    case "connection:get":
    case "connection:save":
      return { data: connection, ok: true };
    case "connection:test":
      return { data: { enabledFeatures: ["BitTorrent", "Metalink"], version: "1.37.0" }, ok: true };
    case "connection:reset":
      return { data: { ...connection, secretStatus: "missing", settings: { ...connection.settings, configured: false } }, ok: true };
    case "snapshot:get":
      return { data: createSnapshot(), ok: true };
    case "task:get":
      return { data: tasks.find((task) => task.gid === request.gid) ?? tasks[0], ok: true };
    case "task:addUris":
      return { data: request.request.uris.map((_, index) => `000000000000000${index}`), ok: true };
    case "task:addMetafile":
      return { data: ["0000000000000001"], ok: true };
    case "task:control":
    case "global:control":
      return { data: "OK", ok: true };
    case "manager:openTab":
      return { data: { tabId: 1 }, ok: true };
  }
}

function createSnapshot(): DownloadSnapshot {
  return {
    active: tasks.filter((task) => task.status === "active"),
    capturedAt: Date.now(),
    global: {
      downloadSpeed: "24600000",
      numActive: "2",
      numStopped: "2",
      numStoppedTotal: "2",
      numWaiting: "1",
      uploadSpeed: "820000"
    },
    stopped: tasks.filter((task) => task.status === "complete" || task.status === "error"),
    waiting: tasks.filter((task) => task.status === "paused" || task.status === "waiting")
  };
}

function makeTask(overrides: Partial<AriaTask>): AriaTask {
  return {
    completedLength: "0",
    dir: "/Users/haerin/Downloads",
    downloadSpeed: "0",
    files: [],
    gid: "0123456789abcdef",
    status: "waiting",
    totalLength: "0",
    uploadLength: "0",
    uploadSpeed: "0",
    ...overrides
  };
}

function makeFile(path: string, length: string, completedLength: string, uri: string) {
  return {
    completedLength,
    index: "1",
    length,
    path,
    selected: "true" as const,
    uris: [{ status: "used" as const, uri }]
  };
}

function createStorageArea(
  data: Record<string, unknown>,
  areaName: string
): chrome.storage.StorageArea {
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) {
        return { ...data };
      }
      const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(names.map((name) => [name, data[name]]));
    },
    async remove(keys: string | string[]) {
      const names = typeof keys === "string" ? [keys] : keys;
      for (const name of names) {
        delete data[name];
      }
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { newValue: value, oldValue: data[key] };
        data[key] = value;
      }
      listeners.forEach((listener) => listener(changes, areaName));
    }
  } as unknown as chrome.storage.StorageArea;
}
