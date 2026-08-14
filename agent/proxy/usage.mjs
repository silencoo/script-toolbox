function safeTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function model(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    ? value
    : null;
}

function openAiServiceTier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 40
    ? value
    : null;
}

function withResponseServiceTier(value, tier) {
  return tier ? { ...value, response_service_tier: tier } : value;
}

function normalized(input, output, cacheRead = 0, cacheWrite = 0) {
  const values = [input, output, cacheRead, cacheWrite].map(safeTokens);
  if (values.some((value) => value === null)) return null;
  return {
    input_tokens: values[0],
    output_tokens: values[1],
    cache_read_tokens: values[2],
    cache_write_tokens: values[3]
  };
}

function nonCached(total, cached) {
  const all = safeTokens(total);
  const hit = safeTokens(cached ?? 0);
  if (all === null || hit === null || hit > all) return null;
  return all - hit;
}

export function extractUsage(protocol, payload) {
  if (Array.isArray(payload)) {
    for (let index = payload.length - 1; index >= 0; index -= 1) {
      const result = extractUsage(protocol, payload[index]);
      if (result?.usage) return result;
    }
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;

  if (protocol === "anthropic_messages") {
    const message = payload.message && typeof payload.message === "object"
      ? payload.message
      : payload;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") return null;
    const value = normalized(
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0
    );
    return value ? {
      response_model: model(message.model || payload.model),
      usage: value,
      source: "anthropic_usage"
    } : null;
  }

  if (protocol === "openai_responses") {
    const response = payload.response && typeof payload.response === "object"
      ? payload.response
      : payload;
    const usage = response.usage;
    if (!usage || typeof usage !== "object") return null;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const input = nonCached(usage.input_tokens, cached);
    const output = safeTokens(usage.output_tokens ?? 0);
    const value = input === null || output === null
      ? null
      : normalized(input, output, cached, 0);
    return value ? withResponseServiceTier({
      response_model: model(response.model || payload.model),
      usage: value,
      source: "openai_responses_usage"
    }, openAiServiceTier(response.service_tier ?? payload.service_tier)) : null;
  }

  if (protocol === "openai_chat") {
    const usage = payload.usage;
    if (!usage || typeof usage !== "object") return null;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const input = nonCached(usage.prompt_tokens, cached);
    const output = safeTokens(usage.completion_tokens ?? 0);
    const value = input === null || output === null
      ? null
      : normalized(input, output, cached, 0);
    return value ? withResponseServiceTier({
      response_model: model(payload.model),
      usage: value,
      source: "openai_chat_usage"
    }, openAiServiceTier(payload.service_tier)) : null;
  }

  if (protocol === "google_generative") {
    const usage = payload.usageMetadata;
    if (!usage || typeof usage !== "object") return null;
    const cached = usage.cachedContentTokenCount ?? 0;
    const input = nonCached(usage.promptTokenCount, cached);
    const output = safeTokens(usage.candidatesTokenCount ?? 0);
    const value = input === null || output === null
      ? null
      : normalized(input, output, cached, 0);
    return value ? {
      response_model: model(payload.modelVersion || payload.model),
      usage: value,
      source: "google_usage_metadata"
    } : null;
  }
  return null;
}

export class UsageCollector {
  constructor(protocol, {
    contentType = "application/json",
    maxJsonBytes = 2 * 1024 * 1024,
    maxSseEventBytes = 2 * 1024 * 1024
  } = {}) {
    this.protocol = protocol;
    this.sse = String(contentType).toLowerCase().includes("text/event-stream");
    this.maxJsonBytes = maxJsonBytes;
    this.maxSseEventBytes = maxSseEventBytes;
    this.decoder = new TextDecoder();
    this.text = "";
    this.jsonBytes = 0;
    this.jsonOverflow = false;
    this.eventData = [];
    this.eventBytes = 0;
    this.dropEvent = false;
    this.discardPartialLine = false;
    this.result = null;
    this.responseModel = null;
    this.responseServiceTier = null;
    this.anthropic = {
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      source: null
    };
  }

  feed(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (!this.sse) {
      this.jsonBytes += chunk.length;
      if (this.jsonBytes > this.maxJsonBytes) {
        this.jsonOverflow = true;
        this.text = "";
        return;
      }
      if (!this.jsonOverflow) this.text += this.decoder.decode(chunk, { stream: true });
      return;
    }
    let decoded = this.decoder.decode(chunk, { stream: true });
    if (this.discardPartialLine) {
      const newline = decoded.search(/[\r\n]/);
      if (newline === -1) return;
      decoded = decoded.slice(newline + 1);
      this.discardPartialLine = false;
    }
    this.text += decoded;
    this.#consumeLines(false);
    if (Buffer.byteLength(this.text) > this.maxSseEventBytes) {
      this.text = "";
      this.dropEvent = true;
      this.discardPartialLine = true;
    }
  }

  #consumeLines(final) {
    const lines = this.text.split(/\r?\n/);
    this.text = final ? "" : lines.pop();
    for (const line of lines) {
      if (line === "") {
        this.#finishEvent();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).replace(/^ /, "");
      this.eventBytes += Buffer.byteLength(data);
      if (this.eventBytes > this.maxSseEventBytes) {
        this.dropEvent = true;
        this.eventData = [];
      } else if (!this.dropEvent) {
        this.eventData.push(data);
      }
    }
  }

  #finishEvent() {
    if (!this.dropEvent && this.eventData.length) {
      const text = this.eventData.join("\n");
      if (text !== "[DONE]") {
        try {
          this.#accept(JSON.parse(text));
        } catch {}
      }
    }
    this.eventData = [];
    this.eventBytes = 0;
    this.dropEvent = false;
  }

  #accept(payload) {
    this.responseServiceTier = openAiServiceTier(
      payload?.response?.service_tier ?? payload?.service_tier
    ) || this.responseServiceTier;
    if (this.protocol === "anthropic_messages") {
      if (payload?.type === "message_start" && payload.message) {
        const value = extractUsage(this.protocol, payload.message);
        if (value) {
          this.responseModel = value.response_model || this.responseModel;
          Object.assign(this.anthropic, value.usage, { source: value.source });
        }
        return;
      }
      if (payload?.type === "message_delta" && payload.usage) {
        const output = safeTokens(payload.usage.output_tokens);
        if (output !== null) {
          this.anthropic.output_tokens = output;
          this.anthropic.source = "anthropic_sse_usage";
        }
        return;
      }
    }
    const value = extractUsage(this.protocol, payload);
    if (value) {
      this.result = value;
      this.responseModel = value.response_model || this.responseModel;
      this.responseServiceTier = value.response_service_tier || this.responseServiceTier;
    } else {
      this.responseModel = model(payload?.model || payload?.modelVersion) ||
        model(payload?.response?.model) || this.responseModel;
    }
  }

  finish() {
    const tail = this.decoder.decode();
    if (tail) this.text += tail;
    if (this.sse) {
      this.#consumeLines(true);
      if (this.text) this.eventData.push(this.text);
      this.#finishEvent();
    } else if (!this.jsonOverflow && this.text) {
      const jsonText = this.text;
      this.text = "";
      try {
        this.#accept(JSON.parse(jsonText));
      } catch {}
    }
    this.text = "";
    if (this.protocol === "anthropic_messages" && [
      this.anthropic.input_tokens,
      this.anthropic.output_tokens,
      this.anthropic.cache_read_tokens,
      this.anthropic.cache_write_tokens
    ].every((value) => value !== null)) {
      return {
        response_model: this.responseModel,
        usage: {
          input_tokens: this.anthropic.input_tokens,
          output_tokens: this.anthropic.output_tokens,
          cache_read_tokens: this.anthropic.cache_read_tokens,
          cache_write_tokens: this.anthropic.cache_write_tokens
        },
        source: this.anthropic.source || "anthropic_usage"
      };
    }
    return this.result ? withResponseServiceTier({
      ...this.result,
      response_model: this.result.response_model || this.responseModel
    }, this.responseServiceTier) : (this.responseModel ? withResponseServiceTier({
      response_model: this.responseModel,
      usage: null,
      source: null
    }, this.responseServiceTier) : null);
  }
}
