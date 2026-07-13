// author=codex-5.6 sol extra high

(function () {
  "use strict";

  var VERSION = "1.1.0";
  var QX_LINE_RE = /^\s*(shadowsocks|vmess|trojan|http|socks5)\s*=/i;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function first(object, keys, fallback) {
    var i;
    for (i = 0; i < keys.length; i += 1) {
      if (hasOwn(object, keys[i]) && object[keys[i]] !== null && object[keys[i]] !== "") {
        return object[keys[i]];
      }
    }
    return fallback;
  }

  function lower(value) {
    return String(value === undefined || value === null ? "" : value).toLowerCase();
  }

  function utf8Bytes(value) {
    var text = String(value || "");
    var bytes = [];
    var i;
    var code;
    var next;
    for (i = 0; i < text.length; i += 1) {
      code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          code = ((code - 0xD800) << 10) + (next - 0xDC00) + 0x10000;
          i += 1;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code < 0x10000) {
        bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      } else {
        bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return bytes;
  }

  function utf8String(bytes) {
    var result = "";
    var i = 0;
    var first;
    var code;
    while (i < bytes.length) {
      first = bytes[i];
      if (first < 0x80) {
        code = first;
        i += 1;
      } else if ((first & 0xE0) === 0xC0 && i + 1 < bytes.length) {
        code = ((first & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
        i += 2;
      } else if ((first & 0xF0) === 0xE0 && i + 2 < bytes.length) {
        code = ((first & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
        i += 3;
      } else if ((first & 0xF8) === 0xF0 && i + 3 < bytes.length) {
        code = ((first & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        i += 4;
      } else {
        code = 0xFFFD;
        i += 1;
      }
      if (code <= 0xFFFF) {
        result += String.fromCharCode(code);
      } else {
        code -= 0x10000;
        result += String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
      }
    }
    return result;
  }

  function base64Encode(value) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var bytes = utf8Bytes(value);
    var output = "";
    var i;
    var a;
    var b;
    var c;
    for (i = 0; i < bytes.length; i += 3) {
      a = bytes[i];
      b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      output += alphabet.charAt(a >> 2);
      output += alphabet.charAt(((a & 3) << 4) | (b >> 4));
      output += i + 1 < bytes.length ? alphabet.charAt(((b & 15) << 2) | (c >> 6)) : "=";
      output += i + 2 < bytes.length ? alphabet.charAt(c & 63) : "=";
    }
    return output;
  }

  function base64Decode(value) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var clean = String(value || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    var bytes = [];
    var i;
    var a;
    var b;
    var c;
    var d;
    if (!clean || /[^A-Za-z0-9+/=]/.test(clean)) return null;
    while (clean.length % 4) clean += "=";
    for (i = 0; i < clean.length; i += 4) {
      a = alphabet.indexOf(clean.charAt(i));
      b = alphabet.indexOf(clean.charAt(i + 1));
      c = clean.charAt(i + 2) === "=" ? 64 : alphabet.indexOf(clean.charAt(i + 2));
      d = clean.charAt(i + 3) === "=" ? 64 : alphabet.indexOf(clean.charAt(i + 3));
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push((a << 2) | (b >> 4));
      if (c < 64) bytes.push(((b & 15) << 4) | (c >> 2));
      if (d < 64) bytes.push(((c & 3) << 6) | d);
    }
    return utf8String(bytes);
  }

  function decodedSubscription(value) {
    var clean = String(value || "").replace(/\s+/g, "");
    var decoded;
    if (clean.length < 16 || /[^A-Za-z0-9+/_=-]/.test(clean)) return null;
    decoded = base64Decode(clean);
    if (!decoded || !/(?:proxies\s*:|trojan:\/\/|ss:\/\/|vmess:\/\/|shadowsocks=|trojan=|vmess=)/i.test(decoded)) return null;
    return decoded;
  }

  function asBoolean(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (/^(true|yes|on|1)$/i.test(String(value))) return true;
    if (/^(false|no|off|0)$/i.test(String(value))) return false;
    return fallback;
  }

  function cleanSingleLine(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  function safeValue(value, label, required) {
    var result = cleanSingleLine(value);
    if (required && !result) throw new Error("缺少 " + label);
    if (result.indexOf(",") !== -1) {
      throw new Error(label + " 包含 Quantumult X 节点格式无法安全表示的逗号");
    }
    return result;
  }

  function safeTag(value) {
    var result = cleanSingleLine(value || "未命名节点");
    return result.replace(/,/g, "，") || "未命名节点";
  }

  function parsePort(value) {
    var port = Number(value);
    if (!isFinite(port) || Math.floor(port) !== port || port < 1 || port > 65535) {
      throw new Error("端口无效");
    }
    return String(port);
  }

  function hostPort(node) {
    var host = safeValue(first(node, ["server", "host", "address"], ""), "server", true);
    var port = parsePort(first(node, ["port", "server-port"], ""));
    if (host.charAt(0) !== "[" && host.indexOf(":") !== -1) host = "[" + host + "]";
    return host + ":" + port;
  }

  function addField(fields, key, value, options) {
    var opts = options || {};
    if (value === undefined || value === null || value === "") {
      if (opts.required) throw new Error("缺少 " + key);
      return;
    }
    fields.push(key + "=" + safeValue(value, key, !!opts.required));
  }

  function commonTail(node, fields, udpFallback) {
    fields.push("fast-open=" + (asBoolean(first(node, ["tfo", "fast-open"], false), false) ? "true" : "false"));
    fields.push("udp-relay=" + (asBoolean(first(node, ["udp", "udp-relay"], udpFallback), udpFallback) ? "true" : "false"));
    fields.push("tag=" + safeTag(node.__qxTag || first(node, ["name", "tag"], "未命名节点")));
  }

  function tlsVerification(node) {
    return asBoolean(first(node, ["skip-cert-verify", "allow-insecure", "insecure"], false), false)
      ? "false"
      : "true";
  }

  function tlsServerName(node) {
    return first(node, ["sni", "servername", "server-name", "tls-host"], "");
  }

  function isTls(node) {
    var security = lower(first(node, ["security"], ""));
    return asBoolean(first(node, ["tls", "over-tls"], false), false) || security === "tls";
  }

  function wsOptions(node) {
    var opts = first(node, ["ws-opts", "ws_opts"], {}) || {};
    var headers = first(opts, ["headers"], {}) || {};
    var legacyHeaders = first(node, ["ws-headers"], {}) || {};
    var host = first(headers, ["Host", "host"], first(legacyHeaders, ["Host", "host"], ""));
    var path = first(opts, ["path"], first(node, ["ws-path"], "/"));
    return { host: host, path: path || "/" };
  }

  function ensureSharedWsHost(sni, httpHost) {
    if (sni && httpHost && lower(sni) !== lower(httpHost)) {
      throw new Error("SNI 与 WebSocket Host 不同，Quantumult X 的 obfs-host 无法无损表示两者");
    }
  }

  function convertTrojan(node) {
    var fields = [];
    var network = lower(first(node, ["network"], "tcp")) || "tcp";
    var password = safeValue(first(node, ["password"], ""), "password", true);
    var sni = tlsServerName(node);
    var ws;
    var wsHost;

    addField(fields, "password", password, { required: true });

    if (network === "tcp") {
      fields.push("over-tls=true");
      addField(fields, "tls-host", sni);
    } else if (network === "ws" || network === "websocket") {
      ws = wsOptions(node);
      ensureSharedWsHost(sni, ws.host);
      wsHost = ws.host || sni || first(node, ["server"], "");
      fields.push("obfs=wss");
      addField(fields, "obfs-host", wsHost);
      addField(fields, "obfs-uri", ws.path || "/");
    } else {
      throw new Error("不支持 Trojan transport: " + network);
    }

    fields.push("tls-verification=" + tlsVerification(node));
    if (asBoolean(first(node, ["tls13"], false), false)) fields.push("tls13=true");
    commonTail(node, fields, false);
    return "trojan=" + hostPort(node) + ", " + fields.join(", ");
  }

  function convertShadowsocks(node) {
    var fields = [];
    var method = first(node, ["cipher", "method"], "");
    var password = first(node, ["password"], "");
    var plugin = lower(first(node, ["plugin"], ""));
    var opts = first(node, ["plugin-opts", "plugin_opts"], {}) || {};
    var mode;
    var pluginTls;

    addField(fields, "method", method, { required: true });
    addField(fields, "password", password, { required: true });

    if (plugin) {
      if (plugin === "obfs" || plugin === "simple-obfs") {
        mode = lower(first(opts, ["mode"], "http"));
        if (mode !== "http" && mode !== "tls") throw new Error("不支持 simple-obfs mode: " + mode);
        fields.push("obfs=" + mode);
        addField(fields, "obfs-host", first(opts, ["host"], ""));
        addField(fields, "obfs-uri", first(opts, ["path"], ""));
      } else if (plugin === "v2ray-plugin") {
        mode = lower(first(opts, ["mode"], "websocket"));
        if (mode !== "websocket") throw new Error("只支持 v2ray-plugin websocket 模式");
        pluginTls = asBoolean(first(opts, ["tls"], false), false);
        fields.push("obfs=" + (pluginTls ? "wss" : "ws"));
        addField(fields, "obfs-host", first(opts, ["host"], ""));
        addField(fields, "obfs-uri", first(opts, ["path"], "/") || "/");
        if (pluginTls) fields.push("tls-verification=" + tlsVerification(node));
      } else {
        throw new Error("不支持 Shadowsocks plugin: " + plugin);
      }
    }

    commonTail(node, fields, false);
    return "shadowsocks=" + hostPort(node) + ", " + fields.join(", ");
  }

  function convertShadowsocksR(node) {
    var fields = [];
    addField(fields, "method", first(node, ["cipher", "method"], ""), { required: true });
    addField(fields, "password", first(node, ["password"], ""), { required: true });
    addField(fields, "ssr-protocol", first(node, ["protocol"], ""), { required: true });
    addField(fields, "ssr-protocol-param", first(node, ["protocol-param", "protocol_param"], ""));
    addField(fields, "obfs", first(node, ["obfs"], ""), { required: true });
    addField(fields, "obfs-host", first(node, ["obfs-param", "obfs_param"], ""));
    commonTail(node, fields, false);
    return "shadowsocks=" + hostPort(node) + ", " + fields.join(", ");
  }

  function vmessMethod(value) {
    var method = lower(value || "none");
    if (method === "auto" || method === "zero") return "none";
    if (method === "chacha20-ietf-poly1305") return "chacha20-poly1305";
    return method;
  }

  function convertVmess(node) {
    var fields = [];
    var network = lower(first(node, ["network"], "tcp")) || "tcp";
    var tls = isTls(node);
    var sni = tlsServerName(node);
    var ws;
    var wsHost;

    addField(fields, "method", vmessMethod(first(node, ["cipher"], "none")), { required: true });
    addField(fields, "password", first(node, ["uuid", "password"], ""), { required: true });

    if (network === "tcp") {
      if (tls) {
        fields.push("obfs=over-tls");
        addField(fields, "obfs-host", sni);
        fields.push("tls-verification=" + tlsVerification(node));
      }
    } else if (network === "ws" || network === "websocket") {
      ws = wsOptions(node);
      ensureSharedWsHost(sni, ws.host);
      wsHost = ws.host || sni || first(node, ["server"], "");
      fields.push("obfs=" + (tls ? "wss" : "ws"));
      addField(fields, "obfs-host", wsHost);
      addField(fields, "obfs-uri", ws.path || "/");
      if (tls) fields.push("tls-verification=" + tlsVerification(node));
    } else if (network === "http") {
      if (tls) throw new Error("不支持 VMess HTTP transport 与 TLS 的无损组合");
      fields.push("obfs=http");
      addField(fields, "obfs-host", first(node, ["http-opts"], {}).headers
        ? first(first(node, ["http-opts"], {}).headers, ["Host", "host"], "")
        : "");
      addField(fields, "obfs-uri", first(first(node, ["http-opts"], {}) || {}, ["path"], ""));
    } else {
      throw new Error("不支持 VMess transport: " + network);
    }

    if (tls && asBoolean(first(node, ["tls13"], false), false)) fields.push("tls13=true");
    commonTail(node, fields, false);
    return "vmess=" + hostPort(node) + ", " + fields.join(", ");
  }

  function convertHttp(node, forceTls) {
    var fields = [];
    var tls = forceTls || isTls(node);
    addField(fields, "username", first(node, ["username"], ""));
    addField(fields, "password", first(node, ["password"], ""));
    if (tls) {
      fields.push("over-tls=true");
      addField(fields, "tls-host", tlsServerName(node));
      fields.push("tls-verification=" + tlsVerification(node));
      if (asBoolean(first(node, ["tls13"], false), false)) fields.push("tls13=true");
    }
    commonTail(node, fields, false);
    return "http=" + hostPort(node) + ", " + fields.join(", ");
  }

  function convertSocks5(node) {
    var fields = [];
    var tls = isTls(node);
    addField(fields, "username", first(node, ["username"], ""));
    addField(fields, "password", first(node, ["password"], ""));
    if (tls) {
      fields.push("over-tls=true");
      addField(fields, "tls-host", tlsServerName(node));
      fields.push("tls-verification=" + tlsVerification(node));
    }
    commonTail(node, fields, false);
    return "socks5=" + hostPort(node) + ", " + fields.join(", ");
  }

  function convertNode(node) {
    var type = lower(first(node, ["type"], ""));
    if (type === "trojan") return convertTrojan(node);
    if (type === "ss" || type === "shadowsocks") return convertShadowsocks(node);
    if (type === "ssr" || type === "shadowsocksr") return convertShadowsocksR(node);
    if (type === "vmess") return convertVmess(node);
    if (type === "http") return convertHttp(node, false);
    if (type === "https") return convertHttp(node, true);
    if (type === "socks5" || type === "socks") return convertSocks5(node);
    throw new Error("不支持协议: " + (type || "未指定"));
  }

  function stripYamlComment(line) {
    var quote = "";
    var escaped = false;
    var depth = 0;
    var i;
    var ch;
    for (i = 0; i < line.length; i += 1) {
      ch = line.charAt(i);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
      } else if (ch === "#" && depth === 0 && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
        return line.slice(0, i).replace(/\s+$/, "");
      }
    }
    return line;
  }

  function yamlLines(text) {
    var raw = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    var result = [];
    var i;
    var expanded;
    var body;
    var indent;
    for (i = 0; i < raw.length; i += 1) {
      expanded = raw[i].replace(/\t/g, "  ");
      body = stripYamlComment(expanded);
      if (!body.trim() || /^\s*(---|\.\.\.)\s*$/.test(body)) continue;
      indent = body.match(/^\s*/)[0].length;
      result.push({ indent: indent, text: body.slice(indent), line: i + 1 });
    }
    return result;
  }

  function splitKeyValue(text) {
    var quote = "";
    var escaped = false;
    var depth = 0;
    var i;
    var ch;
    for (i = 0; i < text.length; i += 1) {
      ch = text.charAt(i);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") depth -= 1;
      else if (ch === ":" && depth === 0) {
        return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
      }
    }
    return null;
  }

  function unquote(value) {
    var quote = value.charAt(0);
    var inner = value.slice(1, -1);
    if (quote === "'") return inner.replace(/''/g, "'");
    try {
      return JSON.parse(value);
    } catch (error) {
      return inner.replace(/\\(["\\/bfnrt])/g, function (_, escape) {
        var map = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        return hasOwn(map, escape) ? map[escape] : escape;
      });
    }
  }

  function scalarFromPlain(value) {
    var text = value.trim();
    if (!text) return "";
    if ((text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
        (text.charAt(0) === "'" && text.charAt(text.length - 1) === "'")) {
      return unquote(text);
    }
    if (/^(null|~)$/i.test(text)) return null;
    if (/^(true|false)$/i.test(text)) return lower(text) === "true";
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
    return text;
  }

  function FlowParser(source) {
    this.source = source;
    this.index = 0;
  }

  FlowParser.prototype.skip = function () {
    while (/\s/.test(this.source.charAt(this.index))) this.index += 1;
  };

  FlowParser.prototype.quoted = function () {
    var start = this.index;
    var quote = this.source.charAt(this.index);
    var escaped = false;
    this.index += 1;
    while (this.index < this.source.length) {
      var ch = this.source.charAt(this.index);
      this.index += 1;
      if (escaped) escaped = false;
      else if (quote === '"' && ch === "\\") escaped = true;
      else if (ch === quote) break;
    }
    return unquote(this.source.slice(start, this.index));
  };

  FlowParser.prototype.plain = function (stops) {
    var start = this.index;
    while (this.index < this.source.length && stops.indexOf(this.source.charAt(this.index)) === -1) {
      this.index += 1;
    }
    return scalarFromPlain(this.source.slice(start, this.index));
  };

  FlowParser.prototype.value = function () {
    this.skip();
    var ch = this.source.charAt(this.index);
    var result;
    var key;
    if (ch === "{") {
      result = {};
      this.index += 1;
      while (this.index < this.source.length) {
        this.skip();
        if (this.source.charAt(this.index) === "}") {
          this.index += 1;
          break;
        }
        key = this.source.charAt(this.index) === '"' || this.source.charAt(this.index) === "'"
          ? this.quoted()
          : this.plain(":");
        this.skip();
        if (this.source.charAt(this.index) !== ":") throw new Error("YAML flow map 缺少冒号");
        this.index += 1;
        result[String(key).trim()] = this.value();
        this.skip();
        if (this.source.charAt(this.index) === ",") this.index += 1;
        else if (this.source.charAt(this.index) !== "}") throw new Error("YAML flow map 格式错误");
      }
      return result;
    }
    if (ch === "[") {
      result = [];
      this.index += 1;
      while (this.index < this.source.length) {
        this.skip();
        if (this.source.charAt(this.index) === "]") {
          this.index += 1;
          break;
        }
        result.push(this.value());
        this.skip();
        if (this.source.charAt(this.index) === ",") this.index += 1;
        else if (this.source.charAt(this.index) !== "]") throw new Error("YAML flow sequence 格式错误");
      }
      return result;
    }
    if (ch === '"' || ch === "'") return this.quoted();
    return this.plain(",]}");
  };

  function parseScalar(value) {
    var text = value.trim();
    if (text.charAt(0) === "{" || text.charAt(0) === "[") return new FlowParser(text).value();
    if (text === "|" || text === ">" || text.indexOf("!!") === 0 || text.charAt(0) === "&" || text.charAt(0) === "*") {
      throw new Error("不支持 YAML multiline/tag/anchor 语法");
    }
    return scalarFromPlain(text);
  }

  function parseBlock(lines, start, indent) {
    var isSequence = lines[start] && lines[start].indent === indent && /^-(?:\s|$)/.test(lines[start].text);
    var index = start;
    var result = isSequence ? [] : {};
    var rest;
    var group;
    var parsed;
    var pair;
    var key;

    if (isSequence) {
      while (index < lines.length && lines[index].indent === indent && /^-(?:\s|$)/.test(lines[index].text)) {
        rest = lines[index].text.replace(/^-\s?/, "");
        index += 1;
        group = [];
        if (rest) group.push({ indent: indent + 2, text: rest, line: lines[index - 1].line });
        while (index < lines.length && lines[index].indent > indent) {
          group.push(lines[index]);
          index += 1;
        }
        if (!group.length) result.push(null);
        else if (group.length === 1 && !splitKeyValue(group[0].text)) {
          result.push(parseScalar(group[0].text));
        } else {
          parsed = parseBlock(group, 0, group[0].indent);
          result.push(parsed.value);
        }
      }
      return { value: result, index: index };
    }

    while (index < lines.length && lines[index].indent === indent && !/^-(?:\s|$)/.test(lines[index].text)) {
      pair = splitKeyValue(lines[index].text);
      if (!pair) throw new Error("YAML 第 " + lines[index].line + " 行不是 key: value");
      key = String(parseScalar(pair[0]));
      index += 1;
      if (pair[1] !== "") {
        result[key] = parseScalar(pair[1]);
      } else if (index < lines.length && lines[index].indent > indent) {
        parsed = parseBlock(lines, index, lines[index].indent);
        result[key] = parsed.value;
        index = parsed.index;
      } else {
        result[key] = null;
      }
    }
    return { value: result, index: index };
  }

  function parseClashYaml(content) {
    var lines = yamlLines(content);
    var i;
    var pair;
    var parsed;
    if (!lines.length) return [];

    for (i = 0; i < lines.length; i += 1) {
      pair = splitKeyValue(lines[i].text);
      if (pair && lower(parseScalar(pair[0])) === "proxies") {
        if (pair[1]) {
          parsed = parseScalar(pair[1]);
          return Array.isArray(parsed) ? parsed : [];
        }
        if (i + 1 < lines.length && lines[i + 1].indent > lines[i].indent) {
          parsed = parseBlock(lines, i + 1, lines[i + 1].indent).value;
          return Array.isArray(parsed) ? parsed : [];
        }
        return [];
      }
    }

    if (/^-(?:\s|$)/.test(lines[0].text)) {
      parsed = parseBlock(lines, 0, lines[0].indent).value;
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  }

  function decodeUriPart(value, plusAsSpace) {
    var text = String(value || "");
    if (plusAsSpace) text = text.replace(/\+/g, " ");
    try {
      return decodeURIComponent(text);
    } catch (ignore) {
      return text;
    }
  }

  function uriQuery(value) {
    var result = {};
    var parts = String(value || "").split("&");
    var i;
    var index;
    var key;
    for (i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      index = parts[i].indexOf("=");
      key = lower(decodeUriPart(index === -1 ? parts[i] : parts[i].slice(0, index), true));
      result[key] = decodeUriPart(index === -1 ? "" : parts[i].slice(index + 1), true);
    }
    return result;
  }

  function parseTrojanUri(value) {
    var source = String(value || "").trim();
    var body = source.slice(9);
    var hashIndex = body.indexOf("#");
    var tag = hashIndex === -1 ? "Trojan" : decodeUriPart(body.slice(hashIndex + 1), false);
    var withoutHash = hashIndex === -1 ? body : body.slice(0, hashIndex);
    var queryIndex = withoutHash.indexOf("?");
    var authority = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
    var query = uriQuery(queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1));
    var atIndex = authority.lastIndexOf("@");
    var password;
    var endpoint;
    var host;
    var port;
    var closing;
    var colon;
    var network;
    var node;
    if (atIndex === -1) throw new Error("Trojan URI 缺少密码");
    password = decodeUriPart(authority.slice(0, atIndex), false);
    endpoint = authority.slice(atIndex + 1);
    if (endpoint.charAt(0) === "[") {
      closing = endpoint.indexOf("]");
      if (closing === -1 || endpoint.charAt(closing + 1) !== ":") throw new Error("Trojan URI 地址无效");
      host = endpoint.slice(1, closing);
      port = endpoint.slice(closing + 2);
    } else {
      colon = endpoint.lastIndexOf(":");
      if (colon === -1) throw new Error("Trojan URI 缺少端口");
      host = endpoint.slice(0, colon);
      port = endpoint.slice(colon + 1);
    }
    network = lower(query.type || query.network || "tcp");
    node = {
      name: tag || "Trojan",
      type: "trojan",
      server: decodeUriPart(host, false),
      port: Number(port),
      password: password,
      sni: query.sni || query.peer || query.servername || query["server-name"] || "",
      network: network,
      udp: asBoolean(query.udp, false),
      tfo: asBoolean(query.tfo || query["fast-open"], false),
      "skip-cert-verify": asBoolean(query.allowinsecure || query.insecure || query["skip-cert-verify"], false)
    };
    if (network === "ws" || network === "websocket") {
      node["ws-opts"] = {
        path: query.path || "/",
        headers: { Host: query.host || query.sni || query.peer || "" }
      };
    }
    return node;
  }

  function parseUriNodes(content) {
    var lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
    var nodes = [];
    var i;
    var line;
    for (i = 0; i < lines.length; i += 1) {
      line = lines[i].trim();
      if (/^trojan:\/\//i.test(line)) nodes.push(parseTrojanUri(line));
    }
    return nodes;
  }

  function parseNodes(content) {
    var raw = String(content || "").replace(/^\uFEFF/, "");
    var trimmed = raw.trim();
    var json;
    var nodes;
    if (!trimmed) return [];

    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
      try {
        json = JSON.parse(trimmed);
        if (Array.isArray(json)) return json;
        nodes = first(json, ["proxies", "Proxy", "proxy"], []);
        if (Array.isArray(nodes)) return nodes;
      } catch (ignore) {}
    }
    return parseClashYaml(raw);
  }

  function qxLines(content) {
    var lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
    var result = [];
    var nonEmpty = 0;
    var i;
    var line;
    for (i = 0; i < lines.length; i += 1) {
      line = lines[i].trim();
      if (!line || line.charAt(0) === "#" || line.charAt(0) === ";") continue;
      nonEmpty += 1;
      if (QX_LINE_RE.test(line)) result.push(line);
    }
    return nonEmpty > 0 && result.length === nonEmpty ? result : [];
  }

  function uniqueTags(nodes) {
    var counts = {};
    var i;
    var tag;
    var key;
    for (i = 0; i < nodes.length; i += 1) {
      if (!nodes[i] || typeof nodes[i] !== "object") continue;
      tag = safeTag(first(nodes[i], ["name", "tag"], "未命名节点"));
      key = lower(tag);
      counts[key] = (counts[key] || 0) + 1;
      nodes[i].__qxTag = counts[key] === 1 ? tag : tag + " (" + counts[key] + ")";
    }
  }

  function convertResource(content) {
    var existing = qxLines(content);
    var nodes;
    var decoded;
    var converted = [];
    var skipped = [];
    var seen = {};
    var i;
    var line;
    var name;

    if (existing.length) {
      return { content: existing.join("\n"), converted: existing.length, skipped: [], version: VERSION };
    }

    nodes = parseNodes(content);
    if (!nodes.length) nodes = parseUriNodes(content);
    if (!nodes.length) {
      decoded = decodedSubscription(content);
      if (decoded) {
        existing = qxLines(decoded);
        if (existing.length) {
          return { content: existing.join("\n"), converted: existing.length, skipped: [], version: VERSION };
        }
        nodes = parseNodes(decoded);
        if (!nodes.length) nodes = parseUriNodes(decoded);
      }
    }
    if (!nodes.length) throw new Error("没有找到 Clash/Mihomo proxies 节点");
    uniqueTags(nodes);

    for (i = 0; i < nodes.length; i += 1) {
      name = nodes[i] && typeof nodes[i] === "object"
        ? safeTag(first(nodes[i], ["name", "tag"], "第 " + (i + 1) + " 个节点"))
        : "第 " + (i + 1) + " 个节点";
      try {
        if (!nodes[i] || typeof nodes[i] !== "object") throw new Error("节点不是对象");
        line = convertNode(nodes[i]);
        if (!seen[line]) {
          converted.push(line);
          seen[line] = true;
        }
      } catch (error) {
        skipped.push(name + ": " + error.message);
      }
    }

    if (!converted.length) {
      throw new Error("所有节点均转换失败" + (skipped.length ? "；" + skipped.slice(0, 3).join("；") : ""));
    }

    return {
      content: converted.join("\n"),
      converted: converted.length,
      skipped: skipped,
      version: VERSION
    };
  }

  function runInQuantumultX() {
    try {
      var result = convertResource($resource.content || "");
      if (result.skipped.length && typeof $notify === "function") {
        $notify(
          "QX Clash Parser " + VERSION,
          "已转换 " + result.converted + " 个，跳过 " + result.skipped.length + " 个",
          result.skipped.slice(0, 4).join("\n")
        );
      }
      $done({ content: base64Encode(result.content) });
    } catch (error) {
      $done({ error: "QX Clash Parser " + VERSION + ": " + error.message });
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      VERSION: VERSION,
      convertResource: convertResource,
      parseNodes: parseNodes,
      convertNode: convertNode,
      base64Encode: base64Encode,
      base64Decode: base64Decode
    };
  }

  if (typeof $resource !== "undefined" && typeof $done === "function") {
    runInQuantumultX();
  }
}());
