export class MemoryR2Object {
  constructor(key, bytes, record) {
    this.key = key;
    this.size = bytes.byteLength;
    this.etag = record.etag;
    this.httpEtag = `"${record.etag}"`;
    this.uploaded = record.uploaded;
    this.httpMetadata = record.httpMetadata;
    this.customMetadata = record.customMetadata;
    this.body = new Blob([bytes]).stream();
    this.#bytes = bytes;
  }

  #bytes;

  async text() {
    return new TextDecoder().decode(this.#bytes);
  }

  async arrayBuffer() {
    return this.#bytes.buffer.slice(
      this.#bytes.byteOffset,
      this.#bytes.byteOffset + this.#bytes.byteLength
    );
  }

  writeHttpMetadata(headers) {
    if (this.httpMetadata?.contentType) {
      headers.set("Content-Type", this.httpMetadata.contentType);
    }
  }
}

export class MemoryR2Bucket {
  constructor() {
    this.records = new Map();
    this.rejectNextHeadPut = false;
    this.etagCounter = 0;
  }

  async put(key, body, options = {}) {
    const current = this.records.get(key);
    const condition = options.onlyIf || {};

    if (condition.etagMatches !== undefined &&
        current?.etag !== condition.etagMatches) {
      return null;
    }
    if (condition.etagDoesNotMatch === "*" && current !== undefined) {
      return null;
    }
    if (this.rejectNextHeadPut && key.endsWith("/head.json")) {
      this.rejectNextHeadPut = false;
      return null;
    }

    const bytes = await bodyBytes(body);
    const record = {
      bytes,
      etag: `etag-${++this.etagCounter}`,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {}
    };
    this.records.set(key, record);
    return new MemoryR2Object(key, bytes, record);
  }

  async get(key) {
    const record = this.records.get(key);
    return record
      ? new MemoryR2Object(key, record.bytes, record)
      : null;
  }

  async delete(key) {
    this.records.delete(key);
  }

  async list(options = {}) {
    const keys = [...this.records.keys()]
      .filter((key) => key.startsWith(options.prefix || ""))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit || 1000;
    const selected = keys.slice(start, start + limit);
    const next = start + selected.length;

    return {
      objects: selected.map((key) => {
        const record = this.records.get(key);
        return new MemoryR2Object(key, record.bytes, record);
      }),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined,
      delimitedPrefixes: []
    };
  }
}

async function bodyBytes(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  throw new TypeError("unsupported fake R2 body");
}
