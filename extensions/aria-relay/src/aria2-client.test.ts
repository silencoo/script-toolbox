import { describe, expect, it, vi } from "vitest";

import { Aria2Client } from "./aria2-client";

describe("Aria2Client", () => {
  it("authenticates with a token and never sends browser credentials or referrer", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: "aria-relay-1", jsonrpc: "2.0", result: { enabledFeatures: [], version: "1.37.0" } })
    );
    const client = new Aria2Client("http://127.0.0.1:6800/jsonrpc", "top-secret", fetchMock);

    await expect(client.getVersion()).resolves.toEqual({ enabledFeatures: [], version: "1.37.0" });

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe("http://127.0.0.1:6800/jsonrpc");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: "aria2.getVersion",
      params: ["token:top-secret"]
    });
  });

  it("maps aria2 unauthorized responses to a useful error without echoing a secret", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        error: { code: 1, message: "Unauthorized" },
        id: "aria-relay-1",
        jsonrpc: "2.0"
      })
    );
    const client = new Aria2Client("http://127.0.0.1:6800/jsonrpc", "never-echo-me", fetchMock);

    await expect(client.getVersion()).rejects.toMatchObject({
      code: 1,
      message: "RPC 密钥不正确或缺失。"
    });
  });

  it("creates one aria2 task per input line with an option allow-list", async () => {
    let responseIndex = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      responseIndex += 1;
      return jsonResponse({ id: `aria-relay-${responseIndex}`, jsonrpc: "2.0", result: `gid000000000000${responseIndex}` });
    });
    const client = new Aria2Client("http://127.0.0.1:6800/jsonrpc", "", fetchMock);

    await expect(
      client.addUris({
        directory: "/downloads",
        headers: ["Authorization: Bearer test"],
        pause: true,
        referer: "https://example.com/page",
        uris: ["https://example.com/a", "https://example.com/b"]
      })
    ).resolves.toHaveLength(2);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { params: unknown[] });
    expect(bodies[0]?.params).toEqual([
      ["https://example.com/a"],
      {
        dir: "/downloads",
        header: ["Authorization: Bearer test"],
        pause: "true",
        referer: "https://example.com/page"
      }
    ]);
    expect(bodies[1]?.params[0]).toEqual(["https://example.com/b"]);
  });

  it("uses addTorrent for .torrent uploads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: "aria-relay-1", jsonrpc: "2.0", result: "0123456789abcdef" })
    );
    const client = new Aria2Client("http://127.0.0.1:6800/jsonrpc", "", fetchMock);

    await expect(
      client.addMetafile({ base64: "ZmlsZQ==", fileName: "linux.torrent", pause: false })
    ).resolves.toEqual(["0123456789abcdef"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe("aria2.addTorrent");
    expect(body.params).toEqual(["ZmlsZQ==", [], { pause: "false" }]);
  });

  it("wraps fetch failures in a stable network error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = new Aria2Client("http://127.0.0.1:6800/jsonrpc", "", fetchMock);

    await expect(client.getVersion()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200
  });
}
