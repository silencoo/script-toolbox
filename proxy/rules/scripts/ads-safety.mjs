import { parse } from "tldts";

// Hosts needed to retrieve these subscriptions and their upstream sources.
export const protectedHosts = [
  "github.com", "api.github.com", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "github.githubassets.com",
];

export function coveredBy(domain, suffixes) {
  for (let candidate = domain; candidate; candidate = candidate.includes(".")
    ? candidate.slice(candidate.indexOf(".") + 1) : "") {
    if (suffixes.has(candidate)) return true;
  }
  return false;
}

export function compactSuffixes(domains) {
  const all = new Set(domains);
  return new Set([...all].filter(domain =>
    !coveredBy(domain.slice(domain.indexOf(".") + 1), all)));
}

export function assertSafeBlocks(domains) {
  for (const domain of domains) {
    const parsed = parse(domain, { allowPrivateDomains: true });
    if ((parsed.isIcann || parsed.isPrivate) && !parsed.domain) {
      throw new Error(`Refusing to block public suffix: ${domain}`);
    }
    if (protectedHosts.some(host => host === domain || host.endsWith(`.${domain}`))) {
      throw new Error(`Refusing to block subscription infrastructure: ${domain}`);
    }
  }
}

export function parseAds(text) {
  const blocks = new Set(), allows = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^HOST-SUFFIX,([^,]+),(direct|Ad Blocking)$/);
    if (match) (match[2] === "direct" ? allows : blocks).add(match[1]);
  }
  return { blocks, allows };
}

export function assertReasonableChange(previous, next) {
  // Compact both sets so redundant children do not count as churn. Compare
  // exact suffixes afterwards: replacing many children with a NEW parent is
  // a significant coverage expansion and must still trigger the guard.
  for (const kind of ["blocks", "allows"]) {
    const before = compactSuffixes(previous[kind]);
    const after = compactSuffixes(next[kind]);
    const added = [...after].filter(d => !before.has(d)).length;
    const removed = [...before].filter(d => !after.has(d)).length;
    const limit = Math.max(10, Math.floor(before.size * 0.10));
    if (added > limit || removed > limit) {
      throw new Error(`Unusually large ${kind} change: +${added}/-${removed} (limit ${limit}). Review upstream changes before replacing the baseline.`);
    }
  }
}

// Curated service hosts must not be hidden by an earlier Ads resource.
// A broad route may intentionally contain ad subdomains; check the route's
// own host/suffix, not every child inside that service domain.
export function assertRoutingOrder(blocks, resources) {
  const adsIndex = resources.findIndex(resource => resource.name === "Ads.list");
  if (adsIndex < 0) throw new Error("Template is missing Ads.list");
  for (const [index, resource] of resources.entries()) {
    if (index <= adsIndex) continue;
    for (const line of resource.text.split(/\r?\n/)) {
      const match = line.match(/^HOST(?:-SUFFIX)?,([^,]+),/);
      if (match && coveredBy(match[1], blocks)) {
        throw new Error(`${resource.name}: ${match[1]} is shadowed by Ads.list; move the service resource before Ads.`);
      }
    }
  }
}
