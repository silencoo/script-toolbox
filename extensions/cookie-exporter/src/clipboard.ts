export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export class ClipboardWriteError extends Error {
  constructor() {
    super("无法写入剪贴板。请保持弹窗打开并再次点击“复制”。");
    this.name = "ClipboardWriteError";
  }
}

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardWriter | undefined = getBrowserClipboard()
): Promise<void> {
  if (!clipboard) {
    throw new ClipboardWriteError();
  }

  try {
    await clipboard.writeText(text);
  } catch {
    throw new ClipboardWriteError();
  }
}

function getBrowserClipboard(): ClipboardWriter | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}
