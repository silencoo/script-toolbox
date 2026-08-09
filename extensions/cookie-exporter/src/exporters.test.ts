import { describe, expect, it } from "vitest";

import { serializeCookies } from "./exporters";
import type { CookieRecord } from "./model";

const exportedAt = new Date("2026-08-09T08:07:06.000Z");
const context = {
  exportedAt,
  modifiedCookieCount: 1,
  scope: "url" as const,
  siteDomain: "example.com",
  sourceUrl: "https://example.com/account"
};

const cookies: CookieRecord[] = [
  {
    domain: ".example.com",
    expirationDate: 1_900_000_000.9,
    hostOnly: false,
    httpOnly: true,
    name: "session",
    partitionKey: {
      topLevelSite: "https://example.com"
    },
    path: "/",
    sameSite: "lax",
    secure: true,
    session: false,
    storeId: "0",
    value: "abc123"
  },
  {
    domain: "example.com",
    hostOnly: true,
    httpOnly: false,
    name: "preference",
    path: "/account",
    sameSite: "strict",
    secure: false,
    session: true,
    storeId: "0",
    value: 'compact,"warm"'
  }
];

describe("serializeCookies", () => {
  it("keeps API metadata in the JSON envelope", () => {
    const output = JSON.parse(serializeCookies("json", cookies, context)) as {
      schema: string;
      cookieCount: number;
      modifiedCookieCount: number;
      schemaVersion: number;
      scope: string;
      siteDomain: string;
      sourceUrl: string;
      cookies: CookieRecord[];
    };

    expect(output.schema).toBe("script-toolbox.cookie-exporter");
    expect(output.schemaVersion).toBe(3);
    expect(output.cookieCount).toBe(2);
    expect(output.modifiedCookieCount).toBe(1);
    expect(output.scope).toBe("url");
    expect(output.siteDomain).toBe("example.com");
    expect(output.sourceUrl).toBe(context.sourceUrl);
    expect(output.cookies[0]?.partitionKey?.topLevelSite).toBe("https://example.com");
  });

  it("writes HttpOnly and persistent fields in Netscape format", () => {
    const output = serializeCookies("netscape", cookies, context);

    expect(output).toContain(
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1900000000\tsession\tabc123"
    );
    expect(output).toContain("# Edited snapshot cookies: 1");
    expect(output).toContain(
      'example.com\tFALSE\t/account\tFALSE\t0\tpreference\tcompact,"warm"'
    );
  });

  it("preserves cookie order in the request header", () => {
    expect(serializeCookies("header", cookies, context)).toBe(
      'Cookie: session=abc123; preference=compact,"warm"\n'
    );
  });

  it("rejects a request header for a whole-site cookie collection", () => {
    expect(() =>
      serializeCookies("header", cookies, {
        ...context,
        scope: "site"
      })
    ).toThrow("只适用于“当前 URL”范围");
  });

  it("escapes quotes according to CSV rules", () => {
    const output = serializeCookies("csv", cookies, context);

    expect(output).toContain('"compact,""warm"""');
    expect(output).toContain('"partitionTopLevelSite"');
  });
});
