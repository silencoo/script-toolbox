import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadConverter(args = {}) {
  const source = await readFile(new URL("./convert-v2.js", import.meta.url), "utf8");
  const context = vm.createContext({ $arguments: args });
  vm.runInContext(`${source}\n;globalThis.__convertV2Main = main;`, context);
  return context.__convertV2Main;
}

const officialGeminiHosts = [
  "lh5.googleusercontent.com",
  "www.googleapis.com",
  "ssl.gstatic.com",
  "fonts.googleapis.com",
  "play.google.com",
  "ogs.google.com",
  "www.google.com",
  "apis.google.com",
  "jnn-pa.googleapis.com",
  "waa-pa.clients6.google.com",
  "i.ytimg.com",
  "yt3.ggpht.com",
  "lh3.googleusercontent.com",
  "maps.gstatic.com",
  "lh3.google.com",
  "ogads-pa.clients6.google.com",
  "csp.withgoogle.com",
  "www.googletagmanager.com",
  "www.youtube.com",
  "fonts.gstatic.com",
  "maps.googleapis.com",
  "static.doubleclick.net",
  "www.gstatic.com",
  "gemini.google.com",
  "td.doubleclick.net",
  "googleads.g.doubleclick.net",
  "www.google-analytics.com",
  "optimizationguide-pa.googleapis.com",
  "encrypted-tbn0.gstatic.com",
  "encrypted-tbn1.gstatic.com",
  "encrypted-tbn2.gstatic.com",
  "encrypted-tbn3.gstatic.com",
  "streetviewpixels-pa.googleapis.com",
  "content-autofill.googleapis.com",
];

const observedGeminiHosts = [
  "robinfrontend-pa.googleapis.com",
  "signaler-pa.googleapis.com",
];

test("keeps Quantumult X and convert-v2 exact Gemini hosts aligned", async () => {
  const source = await readFile(
    new URL("../proxy-rules/sources/gemini.rules", import.meta.url),
    "utf8",
  );
  const sourceRules = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const host of [...officialGeminiHosts, ...observedGeminiHosts]) {
    assert.ok(sourceRules.has(`DOMAIN,${host}`));
  }
});

test("keeps Gemini isolated while general Google traffic stays normal", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "[pro] Residential AI", type: "ss" },
      { name: "[grok] Non-Pro AI", type: "ss" },
      { name: "Japan Node", type: "ss" },
      { name: "Singapore Node", type: "ss" },
      { name: "United States Node", type: "ss" },
      { name: "Taiwan Node", type: "ss" },
      { name: "Hong Kong Node", type: "ss" },
    ],
  });

  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );
  assert.ok(groups.has("AI"));
  assert.ok(groups.has("Gemini"));
  assert.ok(groups.get("AI").proxies.includes("[pro] Residential AI"));
  assert.ok(!groups.get("AI").proxies.includes("[grok] Non-Pro AI"));
  assert.deepEqual(Array.from(groups.get("Gemini").proxies), [
    "United States",
    "Proxies",
    "Auto",
    "Japan",
    "Taiwan",
    "Singapore",
    "Fallback",
    "Direct",
  ]);
  assert.equal(groups.get("Gemini").proxies[0], "United States");
  assert.ok(!groups.get("Gemini").proxies.includes("Hong Kong"));
  assert.ok(!groups.get("Gemini").proxies.includes("[pro] Residential AI"));
  assert.deepEqual(Array.from(groups.get("Proxies").proxies.slice(0, 6)), [
    "Auto",
    "Japan",
    "United States",
    "Taiwan",
    "Singapore",
    "Hong Kong",
  ]);

  const generatedCountryOrder = profile["proxy-groups"]
    .map((group) => group.name)
    .filter((name) =>
      ["Japan", "United States", "Taiwan", "Singapore", "Hong Kong"].includes(
        name,
      ),
    );
  assert.deepEqual(Array.from(generatedCountryOrder), [
    "Japan",
    "United States",
    "Taiwan",
    "Singapore",
    "Hong Kong",
  ]);

  for (const name of [
    "Japan",
    "Singapore",
    "United States",
    "Taiwan",
    "Hong Kong",
  ]) {
    const group = groups.get(name);
    assert.equal(group.url, "https://www.gstatic.com/generate_204");
    assert.equal(group.interval, 600);
    assert.equal(group.tolerance, 100);
    assert.equal(group.lazy, true);
    assert.equal(group.timeout, 5000);
    assert.equal(group["max-failed-times"], 3);
    assert.equal(group["expected-status"], 204);
  }

  assert.equal(groups.get("Auto").interval, 1800);
  assert.equal(groups.get("Fallback").interval, 300);
  for (const name of ["Auto", "Fallback"]) {
    const group = groups.get(name);
    assert.equal(group.url, "https://www.gstatic.com/generate_204");
    assert.equal(group.tolerance, 100);
    assert.equal(group.lazy, true);
    assert.equal(group.timeout, 5000);
    assert.equal(group["max-failed-times"], 3);
    assert.equal(group["expected-status"], 204);
  }

  const gemini = profile.rules.indexOf("DOMAIN,gemini.google.com,Gemini");
  const google = profile.rules.indexOf("DOMAIN-SUFFIX,google.com,Google");
  const staticGemini = profile.rules.indexOf("DOMAIN,t3.gstatic.com,Gemini");
  const staticGoogle = profile.rules.indexOf("DOMAIN-SUFFIX,gstatic.com,Google");
  const geminiYouTube = profile.rules.indexOf("DOMAIN,www.youtube.com,Gemini");
  const generalYouTube = profile.rules.indexOf(
    "DOMAIN-SUFFIX,youtube.com,YouTube",
  );
  const adRules = profile.rules.indexOf("RULE-SET,ADBlock,AdBlock");

  assert.ok(gemini >= 0 && gemini < google);
  assert.ok(staticGemini >= 0 && staticGemini < staticGoogle);
  assert.ok(geminiYouTube >= 0 && geminiYouTube < generalYouTube);
  assert.ok(gemini >= 0 && gemini < adRules);
  for (const host of [...officialGeminiHosts, ...observedGeminiHosts]) {
    assert.ok(profile.rules.includes(`DOMAIN,${host},Gemini`));
  }
  assert.ok(profile.rules.includes("DOMAIN-SUFFIX,perplexity.ai,AI"));
  assert.ok(profile.rules.includes("DOMAIN,copilot.microsoft.com,AI"));
  assert.ok(profile.rules.includes("DOMAIN-SUFFIX,grok.com,AI"));
  assert.ok(profile.rules.includes("GEOSITE,CATEGORY-AI-!CN,AI"));
  assert.equal(profile["rule-providers"].PrivateTracker.behavior, "classical");
  assert.ok(profile.rules.includes("RULE-SET,PrivateTracker,Direct"));
});

test("defaults AI traffic to Proxies when no dedicated AI node exists", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const ai = profile["proxy-groups"].find((group) => group.name === "AI");

  assert.deepEqual(Array.from(ai.proxies), ["Proxies", "Fallback", "Direct"]);
});

test("does not treat country-code substrings as country nodes", async () => {
  const convert = await loadConverter();
  const names = [
    "Plus",
    "Music Server",
    "JPGateway",
    "Network Premium",
    "Design Group",
    "ThinkHub",
  ];
  const profile = convert({
    proxies: names.map((name) => ({ name, type: "ss" })),
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  for (const country of [
    "Japan",
    "United States",
    "Taiwan",
    "Singapore",
    "Hong Kong",
  ]) {
    assert.ok(!groups.has(country));
  }
  assert.deepEqual(Array.from(groups.get("Auto").proxies), names);
});

test("recognizes standalone country codes in common node-name formats", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "US-01", type: "ss" },
      { name: "JP_01", type: "ss" },
      { name: "TW01", type: "ss" },
      { name: "SG 01", type: "ss" },
      { name: "HK-01", type: "ss" },
    ],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.deepEqual(Array.from(groups.get("United States").proxies), ["US-01"]);
  assert.deepEqual(Array.from(groups.get("Japan").proxies), ["JP_01"]);
  assert.deepEqual(Array.from(groups.get("Taiwan").proxies), ["TW01"]);
  assert.deepEqual(Array.from(groups.get("Singapore").proxies), ["SG 01"]);
  assert.deepEqual(Array.from(groups.get("Hong Kong").proxies), ["HK-01"]);
});

test("recognizes pro nodes after a leading country or location icon", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "🇺🇸 [pro] Residential AI", type: "ss" },
      { name: "🇯🇵[PRO] Premium AI", type: "ss" },
      { name: "🌐 [pro] Unclassified AI", type: "ss" },
      { name: "🇺🇸 Standard Node", type: "ss" },
      { name: "🇺🇸 Regular [pro] Label", type: "ss" },
    ],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.deepEqual(Array.from(groups.get("AI").proxies), [
    "🇺🇸 [pro] Residential AI",
    "🇯🇵[PRO] Premium AI",
    "🌐 [pro] Unclassified AI",
    "Proxies",
    "Fallback",
    "Direct",
  ]);
  assert.deepEqual(Array.from(groups.get("Auto").proxies), [
    "🇺🇸 Standard Node",
    "🇺🇸 Regular [pro] Label",
  ]);
});

test("allows periodic URL tests to be tuned or disabled", async () => {
  const convert = await loadConverter({
    urltestinterval: "0",
    urltesttolerance: "50",
    urltestlazy: "false",
  });
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  for (const name of ["Auto", "Fallback", "Japan"]) {
    assert.equal(groups.get(name).interval, 0);
    assert.equal(groups.get(name).tolerance, 50);
    assert.equal(groups.get(name).lazy, false);
  }
});

test("emits the documented Mihomo fake-IP DNS fields", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });

  assert.equal(profile.dns["enhanced-mode"], "fake-ip");
  assert.equal(profile.dns["fake-ip-range"], "198.18.0.1/16");
  assert.equal(profile.dns["fake-ip-range6"], "fdfe:dcba:9876::1/64");
  assert.equal(profile.dns["fake-ip"], undefined);

  const redirHostConvert = await loadConverter({ fakeip: "false" });
  const redirHostProfile = redirHostConvert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  assert.equal(redirHostProfile.dns["enhanced-mode"], "redir-host");
});

test("uses the provider DNS only for matching proxy server domains", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      {
        name: "Special DNS Node",
        type: "ss",
        server: "edge.PLACUDOSHAI.fun.",
        port: 443,
      },
      {
        name: "Regular Node",
        type: "ss",
        server: "regular.example.com",
        port: 443,
      },
    ],
  });

  const expectedPolicy = {
    "+.placudoshai.fun": "https://jeeyio.com/api/dns-query",
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(profile.dns["nameserver-policy"])),
    expectedPolicy,
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(profile.dns["proxy-server-nameserver-policy"]),
    ),
    expectedPolicy,
  );
  assert.deepEqual(
    Array.from(profile.dns["proxy-server-nameserver"]),
    Array.from(profile.dns.nameserver),
  );
  assert.ok(
    !profile.dns["proxy-server-nameserver"].includes(
      "https://jeeyio.com/api/dns-query",
    ),
  );
});

test("omits provider DNS overrides for unrelated subscriptions", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      {
        name: "Regular Node",
        type: "ss",
        server: "regular.example.com",
        port: 443,
      },
    ],
  });

  assert.equal(profile.dns["nameserver-policy"], undefined);
  assert.equal(profile.dns["proxy-server-nameserver"], undefined);
  assert.equal(profile.dns["proxy-server-nameserver-policy"], undefined);
});

test("turns account information nodes into zero-proxy-traffic delay targets", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      {
        name: "剩余流量：128 GB",
        type: "ss",
        server: "subscription.invalid",
        port: 443,
        cipher: "aes-128-gcm",
        password: "unused",
      },
      {
        name: "到期时间：2027-01-01",
        type: "vmess",
        server: "subscription.invalid",
        port: 443,
        uuid: "00000000-0000-0000-0000-000000000000",
      },
      { name: "Japan Node", type: "ss", server: "jp.example", port: 443 },
    ],
  });

  const account = profile["proxy-groups"].find(
    (group) => group.name === "Account Info",
  );
  assert.deepEqual(Array.from(account.proxies), [
    "剩余流量：128 GB",
    "到期时间：2027-01-01",
  ]);
  assert.equal(account.url, "http://wifi.vivo.com.cn/generate_204");
  assert.equal(account.interval, 0);
  assert.equal(account.lazy, true);
  assert.equal(account.timeout, 1000);
  assert.equal(account["expected-status"], 204);

  for (const name of account.proxies) {
    const proxy = profile.proxies.find((item) => item.name === name);
    assert.deepEqual(JSON.parse(JSON.stringify(proxy)), {
      name,
      type: "direct",
      udp: true,
    });
  }

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        profile.proxies.find((proxy) => proxy.name === "Japan Node"),
      ),
    ),
    { name: "Japan Node", type: "ss", server: "jp.example", port: 443 },
  );
});

test("keeps account delay tests independent from the controller port", async () => {
  const convert = await loadConverter({ full: "true" });
  const profile = convert({
    proxies: [{ name: "Traffic: 100 GB", type: "ss" }],
  });
  const account = profile["proxy-groups"].find(
    (group) => group.name === "Account Info",
  );

  assert.equal(profile["external-controller"], ":9999");
  assert.equal(account.url, "http://wifi.vivo.com.cn/generate_204");
});

test("allows each URL-test group class to use its own interval", async () => {
  const convert = await loadConverter({
    autotestinterval: "2400",
    countrytestinterval: "900",
    fallbacktestinterval: "600",
  });
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.equal(groups.get("Auto").interval, 2400);
  assert.equal(groups.get("Japan").interval, 900);
  assert.equal(groups.get("Fallback").interval, 600);
});

test("routes speed tests through a dedicated proxy-first policy", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.ok(groups.has("Speedtest"));
  assert.equal(groups.get("Speedtest").proxies[0], "Proxies");
  assert.equal(
    profile["rule-providers"].Speedtest.url,
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Speedtest/Speedtest.list",
  );

  const speedtest = profile.rules.indexOf("RULE-SET,Speedtest,Speedtest");
  const cdn = profile.rules.indexOf("RULE-SET,StaticResources,CDN");
  const netflix = profile.rules.indexOf("DOMAIN-SUFFIX,fast.com,Netflix");
  assert.ok(speedtest >= 0 && speedtest < cdn && speedtest < netflix);

  const template = await readFile(
    new URL("../proxy-rules/templates/quantumult-x.conf", import.meta.url),
    "utf8",
  );
  assert.match(template, /^static=Speedtest, proxy, direct,/m);
  assert.match(
    template,
    /QuantumultX\/Speedtest\/Speedtest\.list, tag=Speedtest, force-policy=Speedtest/,
  );
  assert.doesNotMatch(template, /host-keyword,\s*speedtest\.net,\s*direct/i);
});

test("routes AI model hubs and downloads before generic CDN rules", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  assert.ok(groups.has("AI Models"));
  assert.equal(groups.get("AI Models").proxies[0], "Proxies");
  assert.equal(
    profile["rule-providers"].AIModels.url,
    "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/ai-models.rules",
  );

  const aiModels = profile.rules.indexOf("RULE-SET,AIModels,AI Models");
  for (const provider of [
    "StaticResources",
    "CDNResources",
    "AdditionalCDNResources",
  ]) {
    const cdn = profile.rules.indexOf(`RULE-SET,${provider},CDN`);
    assert.ok(aiModels >= 0 && aiModels < cdn);
  }

  const source = await readFile(
    new URL("../proxy-rules/sources/ai-models.rules", import.meta.url),
    "utf8",
  );
  for (const domain of [
    "civitai.com",
    "civitai.red",
    "civitai.green",
    "civitai.tech",
    "huggingface.co",
    "hf.co",
  ]) {
    assert.match(
      source,
      new RegExp(`^DOMAIN-SUFFIX,${domain.replaceAll(".", "\\.")}$`, "m"),
    );
  }

  const template = await readFile(
    new URL("../proxy-rules/templates/quantumult-x.conf", import.meta.url),
    "utf8",
  );
  assert.match(template, /^static=AI Models, proxy, direct,/m);
  assert.match(template, /rules\/quantumultx\/AIModels\.list, tag=AI Models/);
});

test("keeps domestic ByteDance rules separate and ahead of TikTok", async () => {
  const byteDanceSource = await readFile(
    new URL("../proxy-rules/sources/bytedance.rules", import.meta.url),
    "utf8",
  );
  const tiktokSource = await readFile(
    new URL("../proxy-rules/sources/tiktok.rules", import.meta.url),
    "utf8",
  );
  const rules = (source) =>
    new Set(
      source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  const byteDanceRules = rules(byteDanceSource);
  const tiktokRules = rules(tiktokSource);

  assert.ok(byteDanceRules.has("DOMAIN-SUFFIX,ixigua.com"));
  assert.ok(byteDanceRules.has("DOMAIN-SUFFIX,douyin.com"));
  assert.ok(byteDanceRules.has("DOMAIN-SUFFIX,snssdk.com"));
  assert.ok(byteDanceRules.has("DOMAIN-SUFFIX,toutiao.com"));
  assert.ok(!byteDanceRules.has("DOMAIN-SUFFIX,unpkg.com"));
  assert.ok(!byteDanceRules.has("DOMAIN-SUFFIX,center.html"));
  for (const rule of byteDanceRules) assert.ok(!tiktokRules.has(rule));

  const template = await readFile(
    new URL("../proxy-rules/templates/quantumult-x.conf", import.meta.url),
    "utf8",
  );
  const byteDance = template.indexOf("rules/quantumultx/ByteDance.list");
  const tiktok = template.indexOf("rules/quantumultx/TikTok.list");
  assert.ok(byteDance >= 0 && byteDance < tiktok);
  assert.doesNotMatch(template, /fmz200\/wool_scripts.*ByteDance\.list/);
  assert.doesNotMatch(template, /host-keyword,\s*(?:douyin|ixigua)\.com/i);

  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  assert.equal(
    profile["rule-providers"].ByteDance.url,
    "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/bytedance.rules",
  );
  assert.equal(
    profile["rule-providers"].TikTok.url,
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/TikTok/TikTok.list",
  );
  const byteDanceRule = profile.rules.indexOf("RULE-SET,ByteDance,Direct");
  const tiktokRule = profile.rules.indexOf("RULE-SET,TikTok,TikTok");
  assert.ok(byteDanceRule >= 0 && byteDanceRule < tiktokRule);
});

test("routes GitHub and Docker through independent developer policies", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [{ name: "Japan Node", type: "ss" }],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  for (const name of ["GitHub", "Docker"]) {
    assert.ok(groups.has(name));
    assert.equal(groups.get(name).proxies[0], "Proxies");
    assert.ok(profile.rules.includes(`RULE-SET,${name},${name}`));
  }
  assert.equal(
    profile["rule-providers"].GitHub.url,
    "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/github.rules",
  );
  assert.equal(
    profile["rule-providers"].Docker.url,
    "https://raw.githubusercontent.com/silencoo/script-toolbox/main/proxy-rules/sources/docker.rules",
  );

  const github = profile.rules.indexOf("RULE-SET,GitHub,GitHub");
  const docker = profile.rules.indexOf("RULE-SET,Docker,Docker");
  const cdn = profile.rules.indexOf("RULE-SET,StaticResources,CDN");
  assert.ok(github >= 0 && github < cdn);
  assert.ok(docker >= 0 && docker < cdn);

  const template = await readFile(
    new URL("../proxy-rules/templates/quantumult-x.conf", import.meta.url),
    "utf8",
  );
  assert.match(template, /^static=GitHub, proxy, direct,/m);
  assert.match(template, /^static=Docker, proxy, direct,/m);
  assert.match(template, /rules\/quantumultx\/GitHub\.list, tag=GitHub/);
  assert.match(template, /rules\/quantumultx\/Docker\.list, tag=Docker/);
  assert.doesNotMatch(template, /^host-keyword,\s*github/m);
  assert.doesNotMatch(template, /^host-keyword,\s*docker\.com/m);
  assert.doesNotMatch(template, /^host,\s*(?:t3|www|ssl)\.gstatic\.com/m);
  assert.doesNotMatch(
    template,
    /^host-keyword,\s*(?:cdnfhnfile\.115cdn\.net|123\.com|pikpak)/m,
  );
});

test("uses the self-hosted z-icon collection for every Quantumult X policy", async () => {
  const template = await readFile(
    new URL("../proxy-rules/templates/quantumult-x.conf", import.meta.url),
    "utf8",
  );
  const policyLines = template
    .split(/\r?\n/)
    .filter((line) => line.startsWith("static="));

  assert.equal(policyLines.length, 22);
  for (const line of policyLines) {
    assert.match(
      line,
      /img-url=https:\/\/raw\.githubusercontent\.com\/silencoo\/z-icon\/main\/icon\//,
    );
  }

  const homarrPolicies = policyLines.filter((line) =>
    line.includes("/icon/homarr/108/"),
  );
  assert.equal(homarrPolicies.length, 16);
  assert.match(
    policyLines.join("\n"),
    /static=X,.*\/icon\/selfhst\/108\/x\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=Global Media,.*\/icon\/homarr\/108\/stb-proxy\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=AI,.*\/icon\/apps-proxy\/chatgpt-v2\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=Apple,.*\/icon\/apps-cn\/apple-v2\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=GitHub,.*\/icon\/selfhst\/108\/git\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=China Sites,.*\/icon\/flag\/108\/China\.png/,
  );
  assert.match(
    policyLines.join("\n"),
    /static=Final,.*\/icon\/proxy-logo\/quanx-v2\.png/,
  );
  assert.doesNotMatch(
    policyLines.join("\n"),
    /Koolson\/Qure|lige47\/QuanX-icon-rule|img-url=[^,\s]+\.system/,
  );
});

test("uses the self-hosted z-icon collection for every convert-v2 group", async () => {
  const convert = await loadConverter();
  const profile = convert({
    proxies: [
      { name: "Japan Node", type: "ss" },
      { name: "Singapore Node", type: "ss" },
      { name: "Taiwan Node", type: "ss" },
      { name: "Hong Kong Node", type: "ss" },
      { name: "United States Node", type: "ss" },
      { name: "Traffic 100GB", type: "ss" },
    ],
  });
  const groups = new Map(
    profile["proxy-groups"].map((group) => [group.name, group]),
  );

  for (const group of groups.values()) {
    assert.match(
      group.icon,
      /^https:\/\/raw\.githubusercontent\.com\/silencoo\/z-icon\/main\/icon\//,
    );
  }

  const expectedIcons = {
    Proxies: "proxy-logo/mihomo.png",
    "Account Info": "apps-cn/testflight.png",
    Auto: "selfhst/108/speedtest-tracker.png",
    Fallback: "homarr/108/haproxy.png",
    CDN: "homarr/108/cloudflare.png",
    AI: "apps-proxy/chatgpt-v2.png",
    Gemini: "homarr/108/google-gemini.png",
    "AI Models": "homarr/108/hugging-face.png",
    GitHub: "selfhst/108/git.png",
    Direct: "selfhst/108/networking-toolbox.png",
    AdBlock: "homarr/108/adguard-home.png",
    GLOBAL: "selfhst/108/world-monitor.png",
  };
  for (const [name, suffix] of Object.entries(expectedIcons)) {
    assert.ok(groups.has(name));
    assert.ok(groups.get(name).icon.endsWith(`/icon/${suffix}`));
  }

  assert.doesNotMatch(
    [...groups.values()].map((group) => group.icon).join("\n"),
    /Koolson\/Qure|powerfullz\/override-rules|WHATSINStash/,
  );
});
