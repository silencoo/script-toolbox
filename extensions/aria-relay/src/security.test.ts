import { describe, expect, it } from "vitest";

import {
  EndpointValidationError,
  isSafeDownloadUri,
  normalizeEndpoint,
  parseUriLines,
  sanitizeHeaderLines
} from "./security";

describe("normalizeEndpoint", () => {
  it("adds the JSON-RPC path and narrows the permission to one origin", () => {
    expect(normalizeEndpoint("http://127.0.0.1:6800")).toEqual({
      endpoint: "http://127.0.0.1:6800/jsonrpc",
      isLoopback: true,
      permissionPattern: "http://127.0.0.1:6800/*",
      usesTls: false
    });
  });

  it("preserves a custom RPC path", () => {
    expect(normalizeEndpoint("https://downloads.example.com/aria/rpc/")).toEqual({
      endpoint: "https://downloads.example.com/aria/rpc",
      isLoopback: false,
      permissionPattern: "https://downloads.example.com/*",
      usesTls: true
    });
  });

  it.each([
    "ws://127.0.0.1:6800/jsonrpc",
    "http://user:pass@127.0.0.1:6800/jsonrpc",
    "http://127.0.0.1:6800/jsonrpc?secret=nope",
    "not a URL"
  ])("rejects unsafe or invalid endpoint %s", (value) => {
    expect(() => normalizeEndpoint(value)).toThrow(EndpointValidationError);
  });
});

describe("download input validation", () => {
  it.each([
    "https://example.com/archive.zip",
    "ftp://mirror.example.com/file.iso",
    "sftp://mirror.example.com/file.iso",
    "magnet:?xt=urn:btih:0123456789abcdef"
  ])("accepts %s", (value) => {
    expect(isSafeDownloadUri(value)).toBe(true);
  });

  it.each(["javascript:location.reload()", "file:///etc/passwd", "data:text/plain,secret", "hello"])(
    "rejects %s",
    (value) => {
      expect(isSafeDownloadUri(value)).toBe(false);
    }
  );

  it("deduplicates line-separated tasks without changing order", () => {
    expect(
      parseUriLines(
        "https://example.com/a\n\nmagnet:?xt=urn:btih:a\nhttps://example.com/a"
      )
    ).toEqual(["https://example.com/a", "magnet:?xt=urn:btih:a"]);
  });

  it("rejects malformed custom header lines", () => {
    expect(() => sanitizeHeaderLines("Authorization: Bearer abc\nInjected value")).toThrow(
      /请求头格式无效/u
    );
  });
});
