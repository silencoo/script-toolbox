import assert from "node:assert/strict";
import test from "node:test";

import worker from "./worker.js";

const UUID = "30e9c5c8-ed28-4cd9-b008-dc67277f8b02";

function workerRequest(query = "") {
  const vless = `vless://${UUID}@origin.example:443?security=tls`;
  return new Request(`https://worker.example/${encodeURIComponent(vless)}${query}`);
}

test("rejects malformed VLESS input before contacting sources", async () => {
  const originalFetch = globalThis.fetch;
  let contacted = false;
  globalThis.fetch = async () => {
    contacted = true;
    throw new Error("unexpected fetch");
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/vless%3A%2F%2Fbad")
    );
    assert.equal(response.status, 400);
    assert.equal(contacted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores malformed sources and ranks valid unique addresses by speed", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/cfxyz")) {
      return new Response("1.1.1.1#10MB/s\n");
    }
    if (url.endsWith("/cu")) {
      return new Response("3.3.3.3#CU\n");
    }
    if (url.includes("wetest.vip")) {
      return Response.json({
        code: 200,
        info: {
          CU: [
            { ip: "2.2.2.2", speed: 100, rtt_avg: 50, colo: "HKG" },
            { ip: "1.1.1.1", speed: 50, rtt_avg: 20, colo: "HKG" }
          ]
        }
      });
    }
    if (url.includes("hostmonit.com")) {
      return Response.json({
        code: 200,
        info: [{ ip: "4.4.4.4", speed: 90, latency: 40 }]
      });
    }

    return new Response("<html>not an IP list</html>");
  };

  try {
    const response = await worker.fetch(
      workerRequest("?remark=CF&limit=10")
    );
    const lines = (await response.text()).split("\n");

    assert.equal(response.status, 200);
    assert.equal(lines.length, 5);
    assert.match(lines[0], /@origin\.example:443/);
    assert.match(lines[1], /@2\.2\.2\.2:443/);
    assert.match(decodeURIComponent(lines[1]), /#\[CF\] WeTest CU HKG 100 Mbps 50 ms$/);
    assert.match(lines[2], /@4\.4\.4\.4:443/);
    assert.match(lines[3], /@1\.1\.1\.1:443/);
    assert.match(lines[4], /@3\.3\.3\.3:443/);
    assert.match(decodeURIComponent(lines[4]), /#\[CF\] CU Preferred$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
