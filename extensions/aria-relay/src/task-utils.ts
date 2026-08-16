import type { AriaFile, AriaTask, AriaTaskStatus, DownloadSnapshot } from "./types";

const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function flattenSnapshot(snapshot: DownloadSnapshot): AriaTask[] {
  return [...snapshot.active, ...snapshot.waiting, ...snapshot.stopped];
}

export function getTaskName(task: AriaTask): string {
  const torrentName = task.bittorrent?.info?.name?.trim();
  if (torrentName) {
    return torrentName;
  }

  const firstPath = task.files.find((file) => file.path)?.path ?? "";
  const pathName = firstPath.split(/[\\/]/u).filter(Boolean).at(-1);
  return pathName || `任务 ${task.gid.slice(0, 8)}`;
}

export function getTaskPrimaryUri(task: AriaTask): string {
  return task.files.flatMap((file) => file.uris).find((uri) => uri.uri)?.uri ?? "";
}

export function getTaskProgress(task: AriaTask): number {
  const total = decimalNumber(task.totalLength);
  const completed = decimalNumber(task.completedLength);
  if (total <= 0) {
    return task.status === "complete" ? 100 : 0;
  }
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

export function getTaskEtaSeconds(task: AriaTask): number | undefined {
  const speed = decimalNumber(task.downloadSpeed);
  const remaining = decimalNumber(task.totalLength) - decimalNumber(task.completedLength);
  if (speed <= 0 || remaining <= 0 || task.status !== "active") {
    return undefined;
  }
  return Math.max(0, Math.round(remaining / speed));
}

export function formatBytes(input: string | number): string {
  const bytes = decimalNumber(input);
  if (bytes <= 0) {
    return "0 B";
  }

  const unitIndex = Math.min(
    DECIMAL_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1_000))
  );
  const scaled = bytes / 1_000 ** unitIndex;
  const precision = scaled >= 100 || unitIndex === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(precision)} ${DECIMAL_UNITS[unitIndex]}`;
}

export function formatSpeed(input: string | number): string {
  return `${formatBytes(input)}/s`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds < 3_600) {
    return `${Math.ceil(seconds / 60)} 分钟`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.ceil((seconds % 3_600) / 60);
    return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.ceil((seconds % 86_400) / 3_600);
  return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

export function getStatusLabel(status: AriaTaskStatus): string {
  const labels: Record<AriaTaskStatus, string> = {
    active: "下载中",
    complete: "已完成",
    error: "错误",
    paused: "已暂停",
    removed: "已移除",
    waiting: "等待中"
  };
  return labels[status];
}

export function getStatusGroup(task: AriaTask): "active" | "waiting" | "complete" | "error" {
  if (task.status === "active") {
    return "active";
  }
  if (task.status === "complete") {
    return "complete";
  }
  if (task.status === "error" || task.status === "removed") {
    return "error";
  }
  return "waiting";
}

export function taskMatchesQuery(task: AriaTask, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  const values = [
    getTaskName(task),
    getTaskPrimaryUri(task),
    task.gid,
    task.dir,
    task.errorMessage ?? ""
  ];
  return values.some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function countSelectedFiles(files: AriaFile[]): number {
  return files.filter((file) => file.selected === "true").length;
}

export function decimalNumber(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
