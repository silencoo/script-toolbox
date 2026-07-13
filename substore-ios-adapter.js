// author=codex-5.6 sol extra high

const FAKE_REMAINING_BYTES = 10 * 1024 * 1024;
const FAKE_EXPIRE_TIMESTAMP = 915148800;
const TRAFFIC_NODE_PATTERN = /(剩余流量|流量剩余|套餐流量|已用流量|流量重置|重置日|到期时间|套餐到期|过期时间|订阅到期|更新订阅|订阅更新|官方网站|官网|防丢|\b(?:traffic|usage|expire[sd]?|remaining|used|total)\b\s*[:：])/i;

function setFakeSubscriptionInfo() {
  if (typeof $options !== "object" || !$options) return;
  if (!$options._res || typeof $options._res !== "object") $options._res = {};
  if (!$options._res.headers || typeof $options._res.headers !== "object") {
    $options._res.headers = {};
  }
  $options._res.headers["subscription-userinfo"] = [
    "upload=0",
    "download=0",
    "total=" + FAKE_REMAINING_BYTES,
    "expire=" + FAKE_EXPIRE_TIMESTAMP
  ].join("; ");
  $options._res.headers["profile-web-page-url"] = null;
  $options._res.headers["plan-name"] = null;
}

function operator(proxies = [], targetPlatform, context) {
  setFakeSubscriptionInfo();
  const input = Array.isArray(proxies) ? proxies : [];
  const output = input.filter((proxy) => {
    const name = proxy && proxy.name != null ? String(proxy.name) : "";
    return !TRAFFIC_NODE_PATTERN.test(name);
  });
  if (typeof $substore === "object" && $substore && typeof $substore.info === "function") {
    $substore.info(
      "iOS adapter: input=" + input.length +
      ", output=" + output.length +
      ", removed=" + (input.length - output.length)
    );
  }
  return output;
}

