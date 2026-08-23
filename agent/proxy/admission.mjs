export class RequestAdmission {
  constructor({ maxRequests, maxBytes }) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1 ||
        !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("request admission limits are invalid");
    }
    this.maxRequests = maxRequests;
    this.maxBytes = maxBytes;
    this.activeRequests = 0;
    this.inflightBytes = 0;
    this.rejectedRequests = 0;
  }

  acquire(reservedBytes = 0) {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) return null;
    if (this.activeRequests >= this.maxRequests ||
        this.inflightBytes + reservedBytes > this.maxBytes) {
      this.rejectedRequests += 1;
      return null;
    }
    this.activeRequests += 1;
    this.inflightBytes += reservedBytes;
    let heldBytes = reservedBytes;
    let released = false;
    return {
      add: (bytes, { countRejection = false } = {}) => {
        if (released || !Number.isSafeInteger(bytes) || bytes < 0) return false;
        if (this.inflightBytes + bytes > this.maxBytes) {
          if (countRejection) this.rejectedRequests += 1;
          return false;
        }
        this.inflightBytes += bytes;
        heldBytes += bytes;
        return true;
      },
      releaseBytes: (bytes) => {
        if (released || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > heldBytes) {
          return false;
        }
        heldBytes -= bytes;
        this.inflightBytes -= bytes;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.inflightBytes -= heldBytes;
        this.activeRequests -= 1;
        heldBytes = 0;
      }
    };
  }

  status() {
    return {
      active_requests: this.activeRequests,
      max_requests: this.maxRequests,
      inflight_request_bytes: this.inflightBytes,
      max_inflight_request_bytes: this.maxBytes,
      rejected_requests: this.rejectedRequests
    };
  }
}
