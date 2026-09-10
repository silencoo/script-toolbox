import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const template = await readFile(
  new URL("../templates/quantumult-x.conf", import.meta.url),
  "utf8",
);

test("scopes the provider DoH endpoint to its Quantumult X node domain", () => {
  assert.match(
    template,
    /^doh-server=\/\*\.placudoshai\.fun\/https:\/\/jeeyio\.com\/api\/dns-query$/m,
  );
  assert.doesNotMatch(
    template,
    /^doh-server=https:\/\/jeeyio\.com\/api\/dns-query$/m,
  );
});

test("routes APNs before broad direct resources while keeping Apple direct-first", () => {
  assert.match(template, /^static=APNs, proxy, direct,/m);
  assert.match(template, /^static=Apple, direct, proxy,/m);
  const remotes = template.split("[filter_remote]")[1].split("[rewrite_remote]")[0];
  const lines = remotes.split("\n").filter((line) => line.startsWith("https://"));
  const apns = lines.findIndex((line) => line.includes("/APNs.list,"));
  assert.ok(apns >= 0);
  assert.match(lines[apns], /tag=APNs,.*opt-parser=false, enabled=true$/);
  for (const resource of ["/Unbreak.list,", "/Apple/Apple.list,"]) {
    assert.ok(lines.findIndex((line) => line.includes(resource)) > apns);
  }
});

test("APNs rules cover push hosts and both IP families without broad Apple routing", async () => {
  const rules = (await readFile(new URL("../rules/quantumultx/APNs.list", import.meta.url), "utf8"))
    .split("\n").filter((line) => line && !line.startsWith("#"));
  const matchesHost = (host) => rules.some((line) => {
    const [type, value, policy] = line.split(",");
    return policy === "APNs" && (type === "HOST" ? host === value :
      type === "HOST-SUFFIX" && (host === value || host.endsWith(`.${value}`)));
  });
  for (const host of ["courier.push.apple.com", "init-p01st-lb.push-apple.com.akadns.net", "courier-push-apple.com.akadns.net"]) {
    assert.ok(matchesHost(host), host);
  }
  for (const host of ["apple.com", "www.apple.com", "icloud.com", "unrelated.akadns.net"]) {
    assert.ok(!matchesHost(host), host);
  }
  assert.ok(rules.every((line) => line.endsWith(",APNs")));
  assert.equal(rules.filter((line) => line.startsWith("IP-CIDR,")).length, 5);
  assert.equal(rules.filter((line) => line.startsWith("IP6-CIDR,")).length, 4);
  assert.ok(rules.includes("IP6-CIDR,2620:149:a44::/48,APNs"));
  assert.ok(!rules.some((line) => line.startsWith("IP-CIDR6,")));
  assert.ok(!rules.includes("IP-CIDR,17.0.0.0/8,APNs"));
});
