#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204"
CN_GEOSITE_URL = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs"
CN_GEOIP_URL = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs"

SIMPLE_SELECTOR_TAG = "proxy"
SIMPLE_AUTO_TAG = "auto"
DIRECT_TAG = "direct"

GROUP_MANUAL = "Proxies"
GROUP_AUTO = "Auto"
GROUP_FALLBACK = "Fallback"
GROUP_BYPASS = "Bypass"
GROUP_FINAL = "Final"

SERVICE_GROUPS = [
    "CDN",
    "AI",
    "Telegram",
    "Meta",
    "Google",
    "YouTube",
    "Bilibili",
    "Netflix",
    "Spotify",
    "Steam",
    "TikTok",
    "PikPak",
    "Crypto",
    "SSH(port 22)",
]

COUNTRY_DEFINITIONS = [
    (
        "Hong Kong",
        re.compile(
            r"(香港|Hong[\s_-]*Kong|HongKong|(?:^|[^A-Za-z0-9])HK(?:$|[^A-Za-z0-9]))",
            re.IGNORECASE,
        ),
    ),
    (
        "Japan",
        re.compile(
            r"(日本|东京|東京|大阪|埼玉|Japan|(?:^|[^A-Za-z0-9])JP(?:$|[^A-Za-z0-9]))",
            re.IGNORECASE,
        ),
    ),
    (
        "Taiwan",
        re.compile(
            r"(台湾|台灣|新北|彰化|Taiwan|(?:^|[^A-Za-z0-9])TW(?:$|[^A-Za-z0-9]))",
            re.IGNORECASE,
        ),
    ),
    (
        "United States",
        re.compile(
            r"(美国|美國|圣何塞|聖何塞|洛杉矶|洛杉磯|阿什本|United[\s_-]*States|USA|U\.S\.A|(?:^|[^A-Za-z0-9])US(?:$|[^A-Za-z0-9]))",
            re.IGNORECASE,
        ),
    ),
    (
        "Singapore",
        re.compile(
            r"(新加坡|狮城|獅城|Singapore|(?:^|[^A-Za-z0-9])SG(?:$|[^A-Za-z0-9]))",
            re.IGNORECASE,
        ),
    ),
]

RESERVED_TAGS = {
    SIMPLE_SELECTOR_TAG,
    SIMPLE_AUTO_TAG,
    DIRECT_TAG,
    GROUP_MANUAL,
    GROUP_AUTO,
    GROUP_FALLBACK,
    GROUP_BYPASS,
    GROUP_FINAL,
    *SERVICE_GROUPS,
    *(name for name, _pattern in COUNTRY_DEFINITIONS),
}


class ComposeError(ValueError):
    pass


@dataclass
class Node:
    tag: str
    server: str
    server_port: int
    password: str
    sni: str
    insecure: bool

    def outbound(self) -> dict:
        return {
            "type": "anytls",
            "tag": self.tag,
            "server": self.server,
            "server_port": self.server_port,
            "password": self.password,
            "tls": {
                "enabled": True,
                "server_name": self.sni,
                "insecure": self.insecure,
            },
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compose multiple AnyTLS node links into simple and grouped sing-box client configs."
    )
    parser.add_argument(
        "--nodes",
        default="nodes.txt",
        help="Path to a file containing one anytls:// link per line. Use '-' for stdin. Default: nodes.txt.",
    )
    parser.add_argument(
        "--simple-out",
        "--out",
        dest="simple_out",
        default="sing-box-client.json",
        help="Output path for the simple proxy config. Use '-' for stdout. Default: sing-box-client.json.",
    )
    parser.add_argument(
        "--grouped-out",
        default="sing-box-client-grouped.json",
        help="Output path for the grouped policy config. Use '-' for stdout. Default: sing-box-client-grouped.json.",
    )
    parser.add_argument(
        "--emit",
        choices=["both", "simple", "grouped"],
        default="both",
        help="Which config(s) to generate. Default: both.",
    )
    parser.add_argument("--listen", default="127.0.0.1", help="Mixed inbound listen address. Default: 127.0.0.1.")
    parser.add_argument("--listen-port", type=int, default=2080, help="Mixed inbound listen port. Default: 2080.")
    parser.add_argument("--selector-tag", default=SIMPLE_SELECTOR_TAG, help="Simple config selector tag. Default: proxy.")
    parser.add_argument("--auto-tag", default=SIMPLE_AUTO_TAG, help="Simple config URL test tag. Default: auto.")
    parser.add_argument("--direct-tag", default=DIRECT_TAG, help="Direct outbound tag. Default: direct.")
    parser.add_argument("--test-url", default=DEFAULT_TEST_URL, help=f"URL test probe URL. Default: {DEFAULT_TEST_URL}.")
    parser.add_argument("--interval", default="3m", help="URL test interval. Default: 3m.")
    parser.add_argument("--tolerance", type=int, default=50, help="URL test tolerance in ms. Default: 50.")
    parser.add_argument(
        "--country-threshold",
        type=int,
        default=1,
        help="Minimum node count required to create a region group. Default: 1.",
    )
    parser.add_argument(
        "--no-selector",
        action="store_true",
        help="Simple config only: route final traffic directly to the auto urltest group.",
    )
    parser.add_argument("--indent", type=int, default=2, help="JSON indentation. Default: 2.")
    return parser.parse_args()


def first_query_value(query: dict[str, list[str]], *names: str) -> str | None:
    for name in names:
        values = query.get(name)
        if values:
            return values[0]
    return None


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def parse_host_port(host_port: str, line_no: int) -> tuple[str, int]:
    if host_port.startswith("["):
        end = host_port.find("]")
        if end == -1:
            raise ComposeError(f"line {line_no}: invalid bracketed IPv6 host")
        host = host_port[1:end]
        rest = host_port[end + 1 :]
        if not rest.startswith(":"):
            raise ComposeError(f"line {line_no}: missing port after IPv6 host")
        port_text = rest[1:]
    else:
        if ":" not in host_port:
            raise ComposeError(f"line {line_no}: missing server port")
        host, port_text = host_port.rsplit(":", 1)
        if ":" in host:
            raise ComposeError(f"line {line_no}: IPv6 hosts must be wrapped in []")

    if not host:
        raise ComposeError(f"line {line_no}: empty server host")
    if not port_text.isdigit():
        raise ComposeError(f"line {line_no}: invalid server port: {port_text}")

    port = int(port_text)
    if not 1 <= port <= 65535:
        raise ComposeError(f"line {line_no}: server port out of range: {port}")

    return host, port


def clean_tag(raw_tag: str, fallback: str) -> str:
    tag = raw_tag.strip() or fallback
    tag = re.sub(r"[\x00-\x1f\x7f]+", "", tag)
    tag = re.sub(r"\s+", "-", tag)
    return tag or fallback


def parse_node_link(line: str, line_no: int) -> Node:
    parsed = urlsplit(line)
    if parsed.scheme != "anytls":
        raise ComposeError(f"line {line_no}: unsupported scheme: {parsed.scheme or '<empty>'}")

    userinfo, separator, host_port = parsed.netloc.rpartition("@")
    if not separator:
        raise ComposeError(f"line {line_no}: missing password userinfo before @")

    password = unquote(userinfo)
    if not password:
        raise ComposeError(f"line {line_no}: empty password")

    server, server_port = parse_host_port(host_port, line_no)
    query = parse_qs(parsed.query, keep_blank_values=True)
    sni = first_query_value(query, "sni", "server_name") or server
    insecure = parse_bool(first_query_value(query, "insecure"), default=False)
    tag = clean_tag(unquote(parsed.fragment), fallback=f"node-{line_no}")

    return Node(
        tag=tag,
        server=server,
        server_port=server_port,
        password=password,
        sni=sni,
        insecure=insecure,
    )


def load_nodes(path: str) -> list[Node]:
    if path == "-":
        lines = sys.stdin.read().splitlines()
    else:
        lines = Path(path).read_text(encoding="utf-8").splitlines()

    nodes: list[Node] = []
    for line_no, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        nodes.append(parse_node_link(line, line_no))

    if not nodes:
        raise ComposeError("no anytls:// nodes found")

    return nodes


def make_unique_tags(nodes: list[Node], reserved_tags: set[str]) -> None:
    used = set(reserved_tags)

    for index, node in enumerate(nodes, start=1):
        base = node.tag or f"node-{index}"
        if base in reserved_tags:
            base = f"{base}-node"

        candidate = base
        suffix = 2
        while candidate in used:
            candidate = f"{base}-{suffix}"
            suffix += 1

        node.tag = candidate
        used.add(candidate)


def validate_options(args: argparse.Namespace) -> None:
    if not 1 <= args.listen_port <= 65535:
        raise ComposeError(f"--listen-port out of range: {args.listen_port}")
    if args.tolerance < 0:
        raise ComposeError("--tolerance must be >= 0")
    if args.country_threshold < 1:
        raise ComposeError("--country-threshold must be >= 1")

    simple_tags = [args.selector_tag, args.auto_tag, args.direct_tag]
    if any(not tag for tag in simple_tags):
        raise ComposeError("outbound tags must not be empty")
    if len(set(simple_tags)) != len(simple_tags):
        raise ComposeError("--selector-tag, --auto-tag, and --direct-tag must be different")

    output_paths = []
    if args.emit in {"both", "simple"}:
        output_paths.append(args.simple_out)
    if args.emit in {"both", "grouped"}:
        output_paths.append(args.grouped_out)
    if output_paths.count("-") > 1:
        raise ComposeError("only one output can use stdout")
    file_paths = [path for path in output_paths if path != "-"]
    if len(file_paths) != len(set(file_paths)):
        raise ComposeError("output paths must be different")


def unique_list(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def make_inbounds(args: argparse.Namespace) -> list[dict]:
    return [
        {
            "type": "mixed",
            "tag": "mixed-in",
            "listen": args.listen,
            "listen_port": args.listen_port,
        }
    ]


def make_dns(proxy_detour: str) -> dict:
    return {
        "servers": [
            {
                "tag": "dns-remote",
                "type": "https",
                "server": "1.1.1.1",
                "detour": proxy_detour,
            },
            {
                "tag": "dns-local",
                "type": "udp",
                "server": "223.5.5.5",
            },
        ],
        "rules": [
            {
                "rule_set": "geosite-cn",
                "server": "dns-local",
            },
            {
                "type": "default",
                "server": "dns-remote",
            },
        ],
    }


def make_cn_rule_sets(download_detour: str) -> list[dict]:
    return [
        {
            "tag": "geosite-cn",
            "type": "remote",
            "format": "binary",
            "url": CN_GEOSITE_URL,
            "download_detour": download_detour,
        },
        {
            "tag": "geoip-cn",
            "type": "remote",
            "format": "binary",
            "url": CN_GEOIP_URL,
            "download_detour": download_detour,
        },
    ]


def base_route_rules(direct_tag: str) -> list[dict]:
    return [
        {
            "inbound": "mixed-in",
            "action": "sniff",
        },
        {
            "protocol": "dns",
            "action": "hijack-dns",
        },
        {
            "ip_is_private": True,
            "outbound": direct_tag,
        },
    ]


def build_simple_config(nodes: list[Node], args: argparse.Namespace) -> dict:
    node_tags = [node.tag for node in nodes]
    final_tag = args.auto_tag if args.no_selector else args.selector_tag

    outbounds: list[dict] = []
    if not args.no_selector:
        outbounds.append(
            {
                "type": "selector",
                "tag": args.selector_tag,
                "outbounds": [args.auto_tag, *node_tags],
                "default": args.auto_tag,
            }
        )

    outbounds.append(
        {
            "type": "urltest",
            "tag": args.auto_tag,
            "outbounds": node_tags,
            "url": args.test_url,
            "interval": args.interval,
            "tolerance": args.tolerance,
        }
    )

    outbounds.extend(node.outbound() for node in nodes)
    outbounds.append({"type": "direct", "tag": args.direct_tag})

    rules = [
        *base_route_rules(args.direct_tag),
        {
            "rule_set": [
                "geosite-cn",
                "geoip-cn",
            ],
            "outbound": args.direct_tag,
        },
    ]

    return {
        "log": {
            "level": "info",
            "timestamp": True,
        },
        "dns": make_dns(final_tag),
        "inbounds": make_inbounds(args),
        "outbounds": outbounds,
        "route": {
            "rule_set": make_cn_rule_sets(final_tag),
            "rules": rules,
            "auto_detect_interface": True,
            "final": final_tag,
            "default_domain_resolver": "dns-local",
        },
    }


def detect_country_groups(nodes: list[Node], threshold: int) -> dict[str, list[str]]:
    matched: dict[str, list[str]] = {name: [] for name, _pattern in COUNTRY_DEFINITIONS}

    for node in nodes:
        for country, pattern in COUNTRY_DEFINITIONS:
            if pattern.search(node.tag):
                matched[country].append(node.tag)
                break

    return {
        country: tags
        for country, tags in matched.items()
        if len(tags) >= threshold
    }


def selector(tag: str, outbounds: list[str], default: str | None = None) -> dict:
    selected = unique_list(outbounds)
    result = {
        "type": "selector",
        "tag": tag,
        "outbounds": selected,
    }
    if default and default in selected:
        result["default"] = default
    return result


def urltest(tag: str, outbounds: list[str], args: argparse.Namespace) -> dict:
    return {
        "type": "urltest",
        "tag": tag,
        "outbounds": unique_list(outbounds),
        "url": args.test_url,
        "interval": args.interval,
        "tolerance": args.tolerance,
    }


def domain_rule(
    outbound: str,
    *,
    domains: list[str] | None = None,
    suffixes: list[str] | None = None,
    keywords: list[str] | None = None,
    ip_cidrs: list[str] | None = None,
    port: int | None = None,
) -> dict:
    rule: dict = {"outbound": outbound}

    if domains:
        rule["domain"] = unique_list(domains)
    if suffixes:
        clean_suffixes = [suffix.lstrip(".") for suffix in suffixes]
        rule["domain"] = unique_list([*rule.get("domain", []), *clean_suffixes])
        rule["domain_suffix"] = unique_list([f".{suffix}" for suffix in clean_suffixes])
    if keywords:
        rule["domain_keyword"] = unique_list(keywords)
    if ip_cidrs:
        rule["ip_cidr"] = unique_list(ip_cidrs)
    if port is not None:
        rule["port"] = port

    return rule


def service_rules() -> list[dict]:
    return [
        domain_rule(
            "SSH(port 22)",
            port=22,
        ),
        domain_rule(
            "AI",
            suffixes=[
                "openai.com",
                "chatgpt.com",
                "oaistatic.com",
                "oaiusercontent.com",
                "anthropic.com",
                "claude.ai",
                "perplexity.ai",
                "poe.com",
                "cursor.com",
                "windsurf.com",
                "githubcopilot.com",
                "deepseek.com",
                "x.ai",
                "grok.com",
            ],
            domains=[
                "gemini.google.com",
                "bard.google.com",
                "generativelanguage.googleapis.com",
                "copilot.microsoft.com",
            ],
            keywords=["openai", "chatgpt", "claude", "anthropic"],
        ),
        domain_rule(
            "Telegram",
            suffixes=[
                "telegram.org",
                "telegram.me",
                "telegram.dog",
                "telegramdownload.com",
                "cdn-telegram.org",
                "t.me",
                "tg.dev",
                "tx.me",
            ],
            domains=["api.imem.app", "api.swiftgram.app"],
            keywords=["nicegram"],
            ip_cidrs=[
                "149.154.160.0/20",
                "91.108.0.0/16",
                "5.28.192.0/18",
            ],
        ),
        domain_rule(
            "YouTube",
            suffixes=[
                "youtube.com",
                "youtube-nocookie.com",
                "youtu.be",
                "ytimg.com",
                "googlevideo.com",
                "ggpht.com",
                "ggpht.cn",
                "gvt1.com",
                "gvt2.com",
            ],
            keywords=["youtube"],
            ip_cidrs=[
                "172.110.32.0/21",
                "216.73.80.0/20",
            ],
        ),
        domain_rule(
            "Meta",
            suffixes=[
                "facebook.com",
                "fb.com",
                "fbcdn.net",
                "instagram.com",
                "cdninstagram.com",
                "whatsapp.com",
                "whatsapp.net",
                "meta.com",
                "messenger.com",
                "threads.net",
                "threads.com",
            ],
        ),
        domain_rule(
            "Netflix",
            suffixes=[
                "netflix.com",
                "netflix.net",
                "nflxext.com",
                "nflximg.com",
                "nflximg.net",
                "nflxso.net",
                "nflxvideo.net",
                "fast.com",
            ],
            keywords=["netflixdnstest", "apiproxy-device-prod-nlb-"],
            ip_cidrs=[
                "23.246.0.0/18",
                "37.77.184.0/21",
                "45.57.0.0/17",
                "64.120.128.0/17",
                "66.197.128.0/17",
                "108.175.32.0/20",
                "198.38.96.0/19",
                "198.45.48.0/20",
                "203.75.84.0/24",
                "203.116.0.0/16",
                "203.198.0.0/20",
                "207.45.72.0/22",
                "208.75.76.0/22",
            ],
        ),
        domain_rule(
            "Spotify",
            suffixes=[
                "spotify.com",
                "scdn.co",
                "spoti.fi",
                "spotifycdn.com",
                "spotifycdn.net",
                "pscdn.co",
            ],
            keywords=["spotify"],
        ),
        domain_rule(
            "Bilibili",
            suffixes=[
                "bilibili.com",
                "bilibili.tv",
                "bili2233.cn",
                "biliapi.com",
                "biliapi.net",
                "bilicdn1.com",
                "bilivideo.cn",
                "bilivideo.com",
                "hdslb.com",
                "smtcdns.net",
                "bahamut.com.tw",
                "bahamut.akamaized.net",
                "gamer.com.tw",
                "hinet.net",
            ],
            domains=["b23.tv"],
        ),
        domain_rule(
            "Google",
            suffixes=[
                "google.com",
                "google.com.hk",
                "google.com.tw",
                "google.co.jp",
                "google.co.uk",
                "google.com.sg",
                "google.com.au",
                "google.com.br",
                "google.ca",
                "google.de",
                "google.fr",
                "google.es",
                "google.it",
                "google.ru",
                "google.com.tr",
                "google.com.mx",
                "google.com.vn",
                "google.co.th",
                "google.co.id",
                "google.co.in",
                "google.com.ph",
                "google.com.my",
                "googleadservices.com",
                "googleapis.com",
                "googlesyndication.com",
                "googleusercontent.com",
                "gstatic.com",
                "google.co.kr",
                "blogspot.com",
                "googlesource.com",
                "google.dev",
                "chrome.com",
                "chromium.org",
                "android.com",
                "firebase.google.com",
                "googletagmanager.com",
                "googletagservices.com",
            ],
            domains=["services.googleapis.cn", "apis.google.com"],
            keywords=["google", "googlesyndication"],
        ),
        domain_rule(
            "Steam",
            suffixes=[
                "steamcommunity.com",
                "steampowered.com",
                "steamstatic.com",
                "steam.tv",
                "s.team",
                "steamgames.com",
                "valvesoftware.com",
                "steamdeck.com",
            ],
            keywords=["steamstore", "steambroadcast"],
        ),
        domain_rule(
            "Crypto",
            suffixes=[
                "crypto.com",
                "crypto.org",
                "cronos.org",
                "cronoscan.com",
                "cronoslabs.org",
                "redotpay.com",
                "cypherhq.io",
                "bitget.com",
                "bitgetapi.com",
                "bitgetimg.com",
                "bitmart.com",
                "bingx.com",
                "coinex.com",
                "lbank.com",
                "phemex.com",
                "backpack.exchange",
                "hyperliquid.xyz",
                "aevo.xyz",
                "paradex.trade",
                "rabby.io",
                "zerion.io",
                "zapper.xyz",
            ],
            domains=["redot.onelink.me"],
        ),
        domain_rule(
            "TikTok",
            suffixes=[
                "tiktok.com",
                "tiktokv.com",
                "tiktokcdn.com",
                "byteoversea.com",
                "ibytedtos.com",
                "ibyteimg.com",
                "muscdn.com",
                "musical.ly",
            ],
            keywords=["tiktok"],
        ),
        domain_rule(
            "PikPak",
            suffixes=["mypikpak.com", "pikpak.me", "pikpakdrive.com"],
            keywords=["pikpak"],
        ),
        domain_rule(
            "CDN",
            suffixes=[
                "cloudflare.com",
                "cloudflare.net",
                "cloudfront.net",
                "akamaihd.net",
                "akamaized.net",
                "fastly.net",
                "jsdelivr.net",
            ],
        ),
    ]


def build_grouped_outbounds(nodes: list[Node], country_groups: dict[str, list[str]], args: argparse.Namespace) -> list[dict]:
    node_tags = [node.tag for node in nodes]
    country_names = list(country_groups)
    residential_nodes = [
        tag
        for tag in node_tags
        if re.search(r"(residential|resident|家宽|家庭|home)", tag, re.IGNORECASE)
    ]

    default_proxy_choices = [GROUP_MANUAL, *country_names, GROUP_BYPASS]
    default_direct_choices = [GROUP_BYPASS, *country_names, GROUP_MANUAL]
    ai_region_order = [
        "United States",
        "Japan",
        "Singapore",
        "Taiwan",
        "Hong Kong",
    ]
    ai_choices = unique_list(
        [
            *residential_nodes,
            *(country for country in ai_region_order if country in country_groups),
            GROUP_MANUAL,
        ]
    )

    outbounds: list[dict] = [
        selector(
            GROUP_MANUAL,
            [GROUP_AUTO, *country_names, *node_tags],
            default=GROUP_AUTO,
        ),
        urltest(GROUP_AUTO, node_tags, args),
        selector(
            GROUP_FALLBACK,
            [GROUP_AUTO, *country_names, GROUP_MANUAL, DIRECT_TAG],
            default=GROUP_AUTO,
        ),
    ]

    for country, tags in country_groups.items():
        outbounds.append(urltest(country, tags, args))

    has_tw = "Taiwan" in country_groups
    has_hk = "Hong Kong" in country_groups

    service_choices: dict[str, list[str]] = {
        "CDN": default_proxy_choices,
        "AI": ai_choices,
        "Telegram": default_proxy_choices,
        "Meta": default_proxy_choices,
        "Google": default_proxy_choices,
        "YouTube": default_proxy_choices,
        "Bilibili": [GROUP_BYPASS, "Taiwan", "Hong Kong", GROUP_MANUAL] if has_tw and has_hk else default_direct_choices,
        "Netflix": default_proxy_choices,
        "Spotify": default_proxy_choices,
        "Steam": default_proxy_choices,
        "TikTok": default_proxy_choices,
        "PikPak": default_proxy_choices,
        "Crypto": default_proxy_choices,
        "SSH(port 22)": default_proxy_choices,
    }

    for group in SERVICE_GROUPS:
        outbounds.append(selector(group, service_choices[group], default=service_choices[group][0]))

    outbounds.extend(
        [
            selector(GROUP_BYPASS, [DIRECT_TAG, GROUP_MANUAL], default=DIRECT_TAG),
            selector(
                GROUP_FINAL,
                [GROUP_MANUAL, GROUP_AUTO, *country_names, GROUP_BYPASS],
                default=GROUP_MANUAL,
            ),
        ]
    )

    outbounds.extend(node.outbound() for node in nodes)
    outbounds.append({"type": "direct", "tag": DIRECT_TAG})

    return outbounds


def build_grouped_config(nodes: list[Node], args: argparse.Namespace) -> tuple[dict, list[str]]:
    country_groups = detect_country_groups(nodes, args.country_threshold)
    country_names = list(country_groups)

    rules = [
        *base_route_rules(DIRECT_TAG),
        *service_rules(),
        {
            "rule_set": [
                "geosite-cn",
                "geoip-cn",
            ],
            "outbound": GROUP_BYPASS,
        },
    ]

    config = {
        "log": {
            "level": "info",
            "timestamp": True,
        },
        "dns": make_dns(GROUP_MANUAL),
        "inbounds": make_inbounds(args),
        "outbounds": build_grouped_outbounds(nodes, country_groups, args),
        "route": {
            "rule_set": make_cn_rule_sets(GROUP_MANUAL),
            "rules": rules,
            "auto_detect_interface": True,
            "final": GROUP_FINAL,
            "default_domain_resolver": "dns-local",
        },
    }

    return config, country_names


def write_config(config: dict, output_path: str, indent: int, label: str) -> None:
    data = json.dumps(config, ensure_ascii=False, indent=indent)
    if output_path == "-":
        print(data)
        print(f"[sing-box-client] wrote {label} config to stdout", file=sys.stderr)
        return

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data + "\n", encoding="utf-8")
    print(f"[sing-box-client] wrote {label} config: {path}", file=sys.stderr)


def main() -> int:
    args = parse_args()
    try:
        validate_options(args)
        nodes = load_nodes(args.nodes)
        make_unique_tags(nodes, RESERVED_TAGS | {args.selector_tag, args.auto_tag, args.direct_tag})

        if args.emit in {"both", "simple"}:
            simple_config = build_simple_config(nodes, args)
            write_config(simple_config, args.simple_out, args.indent, "simple")
            print(
                f"[sing-box-client] simple nodes={len(nodes)} final={simple_config['route']['final']}",
                file=sys.stderr,
            )

        if args.emit in {"both", "grouped"}:
            grouped_config, countries = build_grouped_config(nodes, args)
            write_config(grouped_config, args.grouped_out, args.indent, "grouped")
            country_text = ",".join(countries) if countries else "none"
            print(
                f"[sing-box-client] grouped nodes={len(nodes)} countries={country_text} final={grouped_config['route']['final']}",
                file=sys.stderr,
            )
    except (ComposeError, OSError) as exc:
        print(f"[sing-box-client] ERROR: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
