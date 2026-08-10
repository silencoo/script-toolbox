import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelMappingError,
  mapNativeModelRequest,
  resolveExactModel
} from "../proxy/model-mapper.mjs";
import { UsageCollector, extractUsage } from "../proxy/usage.mjs";

const models = {
  default: "friendly",
  aliases: {
    friendly: "vendor-model-2026",
    compact: "vendor-compact-2026"
  }
};

test("model aliases use exact matches and preserve requested/outbound identity", () => {
  assert.deepEqual(resolveExactModel(models, "friendly"), {
    requested_model: "friendly",
    outbound_model: "vendor-model-2026",
    mapped: true
  });
  assert.deepEqual(resolveExactModel(models, "friendly-preview"), {
    requested_model: "friendly-preview",
    outbound_model: "friendly-preview",
    mapped: false
  });
  const mapped = mapNativeModelRequest({
    protocol: "openai_responses",
    method: "POST",
    pathname: "/v1/responses",
    body: Buffer.from('{"model":"friendly","input":"private-content"}'),
    models
  });
  assert.equal(mapped.requested_model, "friendly");
  assert.equal(mapped.outbound_model, "vendor-model-2026");
  assert.deepEqual(JSON.parse(mapped.body), {
    model: "vendor-model-2026",
    input: "private-content"
  });

  const inserted = mapNativeModelRequest({
    protocol: "anthropic_messages",
    method: "POST",
    pathname: "/v1/messages",
    body: Buffer.from('{"messages":[]}'),
    models
  });
  assert.equal(JSON.parse(inserted.body).model, "vendor-model-2026");
  assert.equal(inserted.requested_model, "friendly");
});

test("Google model mapping changes only the exact route component", () => {
  const mapped = mapNativeModelRequest({
    protocol: "google_generative",
    method: "POST",
    pathname: "/v1beta/models/friendly:streamGenerateContent",
    body: Buffer.from('{"contents":[]}'),
    models
  });
  assert.equal(
    mapped.pathname,
    "/v1beta/models/vendor-model-2026:streamGenerateContent"
  );
  assert.equal(mapped.requested_model, "friendly");
  const lookalike = mapNativeModelRequest({
    protocol: "google_generative",
    method: "POST",
    pathname: "/v1beta/models/friendly-preview:generateContent",
    body: Buffer.from("{}"),
    models
  });
  assert.equal(
    lookalike.pathname,
    "/v1beta/models/friendly-preview:generateContent"
  );
});

test("model mapper rejects alias cycles and malformed native request bodies", () => {
  assert.throws(() => resolveExactModel({
    default: "a",
    aliases: { a: "b", b: "a" }
  }), ModelMappingError);
  assert.throws(() => mapNativeModelRequest({
    protocol: "openai_chat",
    method: "POST",
    pathname: "/v1/chat/completions",
    body: Buffer.from("not-json"),
    models
  }), /valid JSON/);
  assert.throws(() => mapNativeModelRequest({
    protocol: "openai_chat",
    method: "POST",
    pathname: "/v1/chat/completions",
    body: Buffer.from('{"model":7}'),
    models
  }), /must be a string/);
});

test("usage normalization keeps each vendor's cache semantics separate", () => {
  assert.deepEqual(extractUsage("anthropic_messages", {
    model: "claude-response",
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 20
    }
  }), {
    response_model: "claude-response",
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 70,
      cache_write_tokens: 20
    },
    source: "anthropic_usage"
  });
  assert.deepEqual(extractUsage("openai_responses", {
    model: "gpt-response",
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      input_tokens_details: { cached_tokens: 70 }
    }
  }).usage, {
    input_tokens: 30,
    output_tokens: 40,
    cache_read_tokens: 70,
    cache_write_tokens: 0
  });
  assert.deepEqual(extractUsage("openai_chat", {
    model: "chat-response",
    usage: {
      prompt_tokens: 90,
      completion_tokens: 15,
      prompt_tokens_details: { cached_tokens: 50 }
    }
  }).usage, {
    input_tokens: 40,
    output_tokens: 15,
    cache_read_tokens: 50,
    cache_write_tokens: 0
  });
  assert.deepEqual(extractUsage("google_generative", {
    modelVersion: "gemini-response",
    usageMetadata: {
      promptTokenCount: 80,
      candidatesTokenCount: 25,
      cachedContentTokenCount: 60
    }
  }).usage, {
    input_tokens: 20,
    output_tokens: 25,
    cache_read_tokens: 60,
    cache_write_tokens: 0
  });
  assert.equal(extractUsage("openai_responses", {
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 11 }
    }
  }), null);
});

test("SSE collectors extract final metadata without retaining output content", () => {
  const anthropic = new UsageCollector("anthropic_messages", {
    contentType: "text/event-stream"
  });
  anthropic.feed(Buffer.from(
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-final","usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}\n\n'
  ));
  anthropic.feed(Buffer.from(
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"PRIVATE OUTPUT"}}\n\n'
  ));
  anthropic.feed(Buffer.from(
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'
  ));
  assert.deepEqual(anthropic.finish(), {
    response_model: "claude-final",
    usage: {
      input_tokens: 12,
      output_tokens: 9,
      cache_read_tokens: 7,
      cache_write_tokens: 3
    },
    source: "anthropic_sse_usage"
  });

  const responses = new UsageCollector("openai_responses", {
    contentType: "text/event-stream"
  });
  const frame = 'data: {"type":"response.completed","response":{"model":"gpt-final","output":[{"content":"PRIVATE"}],"usage":{"input_tokens":20,"output_tokens":4,"input_tokens_details":{"cached_tokens":5}}}}\n\n';
  responses.feed(Buffer.from(frame.slice(0, 41)));
  responses.feed(Buffer.from(frame.slice(41)));
  assert.deepEqual(responses.finish(), {
    response_model: "gpt-final",
    usage: {
      input_tokens: 15,
      output_tokens: 4,
      cache_read_tokens: 5,
      cache_write_tokens: 0
    },
    source: "openai_responses_usage"
  });
});

test("non-stream collector is bounded and still reports a response model when usage is absent", () => {
  const collector = new UsageCollector("openai_chat", {
    contentType: "application/json",
    maxJsonBytes: 64
  });
  collector.feed(Buffer.from('{"model":"chat-only","choices":[]}'));
  assert.deepEqual(collector.finish(), {
    response_model: "chat-only",
    usage: null,
    source: null
  });
  const overflow = new UsageCollector("openai_chat", {
    contentType: "application/json",
    maxJsonBytes: 8
  });
  overflow.feed(Buffer.from('{"model":"too-large"}'));
  assert.equal(overflow.finish(), null);
});
