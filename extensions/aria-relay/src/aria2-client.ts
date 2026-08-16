import { isSafeDownloadUri } from "./security";
import type {
  AddMetafileRequest,
  AddUriRequest,
  AriaGlobalStat,
  AriaTask,
  AriaVersion,
  DownloadSnapshot,
  GlobalControlAction,
  TaskControlAction
} from "./types";

interface JsonRpcSuccess<T> {
  id: string;
  jsonrpc: "2.0";
  result: T;
}

interface JsonRpcFailure {
  error: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: string | null;
  jsonrpc: "2.0";
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

type FetchLike = typeof fetch;

const TASK_KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "uploadLength",
  "downloadSpeed",
  "uploadSpeed",
  "dir",
  "files",
  "bittorrent",
  "infoHash",
  "connections",
  "numSeeders",
  "seeder",
  "errorCode",
  "errorMessage",
  "followedBy",
  "following",
  "verifiedLength",
  "verifyIntegrityPending"
] as const;

export class Aria2RpcError extends Error {
  override name = "Aria2RpcError";

  constructor(
    message: string,
    public readonly code: number | string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class Aria2Client {
  private requestNumber = 0;

  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async getVersion(): Promise<AriaVersion> {
    return this.call<AriaVersion>("aria2.getVersion");
  }

  async getSnapshot(maxResults: number): Promise<DownloadSnapshot> {
    const [global, active, waiting, stopped] = await Promise.all([
      this.call<AriaGlobalStat>("aria2.getGlobalStat"),
      this.call<AriaTask[]>("aria2.tellActive", [[...TASK_KEYS]]),
      this.call<AriaTask[]>("aria2.tellWaiting", [0, maxResults, [...TASK_KEYS]]),
      this.call<AriaTask[]>("aria2.tellStopped", [0, maxResults, [...TASK_KEYS]])
    ]);

    return {
      active,
      capturedAt: Date.now(),
      global,
      stopped,
      waiting
    };
  }

  async getTask(gid: string): Promise<AriaTask> {
    assertGid(gid);
    return this.call<AriaTask>("aria2.tellStatus", [gid, [...TASK_KEYS]]);
  }

  async addUris(request: AddUriRequest): Promise<string[]> {
    const gids: string[] = [];
    for (const uri of request.uris) {
      if (!isSafeDownloadUri(uri)) {
        throw new Aria2RpcError("下载地址使用了不受支持的协议。", "INVALID_URI");
      }
      const options = buildTaskOptions(request);
      gids.push(await this.call<string>("aria2.addUri", [[uri], options]));
    }
    return gids;
  }

  async addMetafile(request: AddMetafileRequest): Promise<string[]> {
    if (!request.base64 || request.base64.length > 64 * 1024 * 1024) {
      throw new Aria2RpcError("BT 或 Metalink 文件为空或超过 48 MiB 限制。", "INVALID_FILE");
    }

    const options = buildTaskOptions({
      ...(request.directory ? { directory: request.directory } : {}),
      ...(request.pause === undefined ? {} : { pause: request.pause }),
      uris: []
    });

    if (/\.(?:meta4|metalink)$/iu.test(request.fileName)) {
      return this.call<string[]>("aria2.addMetalink", [request.base64, options]);
    }

    if (/\.torrent$/iu.test(request.fileName)) {
      const gid = await this.call<string>("aria2.addTorrent", [request.base64, [], options]);
      return [gid];
    }

    throw new Aria2RpcError("仅支持 .torrent、.metalink 或 .meta4 文件。", "INVALID_FILE_TYPE");
  }

  async controlTask(gid: string, action: TaskControlAction): Promise<string> {
    assertGid(gid);

    switch (action) {
      case "pause":
        return this.call<string>("aria2.pause", [gid]);
      case "resume":
        return this.call<string>("aria2.unpause", [gid]);
      case "remove":
        return this.call<string>("aria2.forceRemove", [gid]);
      case "forget":
        return this.call<string>("aria2.removeDownloadResult", [gid]);
      case "retry":
        return this.retryTask(gid);
    }
  }

  async controlGlobal(action: GlobalControlAction): Promise<string> {
    switch (action) {
      case "pauseAll":
        return this.call<string>("aria2.pauseAll");
      case "resumeAll":
        return this.call<string>("aria2.unpauseAll");
      case "purgeResults":
        return this.call<string>("aria2.purgeDownloadResult");
    }
  }

  private async retryTask(gid: string): Promise<string> {
    const task = await this.getTask(gid);
    const uri = task.files.flatMap((file) => file.uris).find((item) => item.uri)?.uri;

    if (!uri || !isSafeDownloadUri(uri)) {
      throw new Aria2RpcError("这个任务没有可重新提交的来源地址。", "NO_RETRY_URI");
    }

    const out = getTaskOutputName(task);
    const options = buildTaskOptions({
      directory: task.dir,
      ...(out ? { out } : {}),
      uris: []
    });
    return this.call<string>("aria2.addUri", [[uri], options]);
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = `aria-relay-${++this.requestNumber}`;
    const authenticatedParams = this.secret ? [`token:${this.secret}`, ...params] : params;
    let response: Response;

    try {
      response = await this.fetchImpl(this.endpoint, {
        body: JSON.stringify({
          id,
          jsonrpc: "2.0",
          method,
          params: authenticatedParams
        }),
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(8_000)
      });
    } catch (error) {
      throw new Aria2RpcError(
        "无法连接 aria2 RPC。请确认服务、地址和扩展主机授权。",
        "NETWORK_ERROR",
        { cause: error }
      );
    }

    if (!response.ok) {
      throw new Aria2RpcError(`aria2 RPC 返回 HTTP ${response.status}。`, response.status);
    }

    let payload: JsonRpcResponse<T>;
    try {
      payload = (await response.json()) as JsonRpcResponse<T>;
    } catch (error) {
      throw new Aria2RpcError("aria2 RPC 返回了无效的 JSON。", "INVALID_RESPONSE", {
        cause: error
      });
    }

    if ("error" in payload) {
      const message = payload.error.code === 1 && /unauthorized/iu.test(payload.error.message)
        ? "RPC 密钥不正确或缺失。"
        : payload.error.message;
      throw new Aria2RpcError(message, payload.error.code);
    }

    return payload.result;
  }
}

function buildTaskOptions(
  request: Omit<AddUriRequest, "uris"> | AddUriRequest
): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {};

  if (request.directory?.trim()) {
    options.dir = request.directory.trim();
  }
  if (request.out?.trim()) {
    options.out = sanitizeOutputName(request.out);
  }
  if (request.pause !== undefined) {
    options.pause = request.pause ? "true" : "false";
  }
  if (request.referer?.trim()) {
    options.referer = request.referer.trim();
  }
  if (request.headers?.length) {
    options.header = request.headers.slice(0, 50);
  }

  return options;
}

function sanitizeOutputName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[/\\\0]/u.test(name)) {
    throw new Aria2RpcError("输出文件名不能包含路径分隔符。", "INVALID_OUTPUT_NAME");
  }
  return name.slice(0, 255);
}

function assertGid(gid: string): void {
  if (!/^[0-9a-f]{16}$/iu.test(gid)) {
    throw new Aria2RpcError("任务 GID 无效。", "INVALID_GID");
  }
}

function getTaskOutputName(task: AriaTask): string {
  const firstPath = task.files[0]?.path ?? "";
  return firstPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}
