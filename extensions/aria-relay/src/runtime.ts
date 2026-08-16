import type { ExtensionRequest, ExtensionResponse } from "./types";

export async function sendRequest<T>(request: ExtensionRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T> | undefined;
  if (!response) {
    throw new Error("后台服务没有响应，请重新加载扩展。");
  }
  if (!response.ok) {
    const error = new Error(response.message);
    error.name = response.code;
    throw error;
  }
  return response.data;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误。";
}
