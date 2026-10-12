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

const activeLines = (text) => text.split(/\r?\n/).map((line) => line.trim())
  .filter((line) => line && !/^(?:#|;|\/\/)/.test(line));
const section = (name) => template.split(`[${name}]`)[1].split(/^\[/m)[0];
const remoteResources = activeLines(section("filter_remote")).map((line) => {
  const [url, ...fields] = line.split(",").map((field) => field.trim());
  const options = Object.fromEntries(fields.map((field) => {
    const index = field.indexOf("=");
    return [field.slice(0, index), field.slice(index + 1)];
  }));
  return { url, options };
}).filter(({ options }) => options.enabled !== "false");

test("local DNS uses encrypted defaults without an ordinary plaintext fallback", () => {
  const dns = activeLines(section("dns"));
  assert.ok(dns.includes("no-system"));
  assert.ok(dns.includes("no-ipv6"));
  assert.ok(!dns.some((line) => /^server\s*=/.test(line)), "No plaintext DNS upstreams");
  assert.deepEqual(dns.filter((line) => /^doh-server=https:/.test(line)),
    ["doh-server=https://223.5.5.5/dns-query"]);
});

test("China domains follow service rules and the hostname fallback is the last enabled remote", () => {
  const china = remoteResources.at(-2);
  assert.equal(china.options.tag, "China Sites");
  assert.equal(china.url,
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/QuantumultX/ChinaMaxNoIP/ChinaMaxNoIP.list");
  assert.equal(china.options["force-policy"], "China Sites");
  assert.equal(china.options["opt-parser"], "false");
  assert.ok(!remoteResources.some(({ url }) => url.includes("ASN.China.list")));

  const fallback = remoteResources.at(-1);
  assert.equal(fallback.options.tag, "Hostname Fallback");
  assert.equal(fallback.url,
    "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/rules/quantumultx/HostnameFallback.list");
  assert.equal(fallback.options["opt-parser"], "false");
  assert.equal(fallback.options["force-policy"], undefined);
  assert.equal(remoteResources.filter(({ options }) => options.tag === "Hostname Fallback").length, 1);
  assert.ok(remoteResources.every(({ options }) => options["inserted-resource"] !== "true"),
    "Preserve local hostname override priority");
  assert.ok(!activeLines(section("filter_local")).some((line) =>
    /^host-keyword\s*,\s*\.\s*,/i.test(line)), "No local catch-all shadowing service resources");
});

test("generated hostname fallback selects Final without adding an IP or final catch-all", async () => {
  const output = await readFile(new URL("../rules/quantumultx/HostnameFallback.list", import.meta.url), "utf8");
  assert.deepEqual(activeLines(output), ["HOST-KEYWORD,.,Final"]);
  assert.ok(activeLines(section("filter_local")).includes("geoip, cn, direct"),
    "Keep the literal-IP regional fallback");
  assert.ok(activeLines(section("filter_local")).includes("final, Final"));
});
