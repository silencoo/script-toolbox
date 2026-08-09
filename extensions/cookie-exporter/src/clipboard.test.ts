import { describe, expect, it, vi } from "vitest";

import { ClipboardWriteError, copyTextToClipboard } from "./clipboard";

describe("copyTextToClipboard", () => {
  it("writes the complete serialized text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyTextToClipboard("Cookie: session=secret\n", { writeText });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("Cookie: session=secret\n");
  });

  it("reports a useful error when the clipboard is unavailable", async () => {
    await expect(copyTextToClipboard("secret", undefined)).rejects.toBeInstanceOf(
      ClipboardWriteError
    );
  });

  it("does not expose the browser error when writing is rejected", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("platform details"));

    await expect(copyTextToClipboard("secret", { writeText })).rejects.toThrow(
      "无法写入剪贴板"
    );
  });
});
