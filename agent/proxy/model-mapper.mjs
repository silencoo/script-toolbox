import { validateModelId } from "../agentctl/provider-schema.mjs";

export class ModelMappingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelMappingError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateModels(models) {
  if (!plainObject(models) || typeof models.default !== "string" ||
      !plainObject(models.aliases)) {
    throw new ModelMappingError("proxy model configuration is invalid");
  }
  validateModelId(models.default, "proxy default model");
  for (const [requested, outbound] of Object.entries(models.aliases)) {
    validateModelId(requested, "proxy model alias");
    validateModelId(outbound, `proxy outbound model for '${requested}'`);
  }
  return models;
}

export function resolveExactModel(models, requested = undefined) {
  validateModels(models);
  const requestedModel = requested === undefined ? models.default : requested;
  validateModelId(requestedModel, "requested model");
  const seen = new Set();
  let outboundModel = requestedModel;
  while (Object.hasOwn(models.aliases, outboundModel)) {
    if (seen.has(outboundModel)) {
      throw new ModelMappingError(`model alias cycle detected at '${outboundModel}'`);
    }
    seen.add(outboundModel);
    outboundModel = models.aliases[outboundModel];
  }
  return {
    requested_model: requestedModel,
    outbound_model: outboundModel,
    mapped: requestedModel !== outboundModel
  };
}

function parseJsonObject(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ModelMappingError("native model request requires a JSON object body");
  }
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ModelMappingError("native model request body is not valid JSON");
  }
  if (!plainObject(value)) {
    throw new ModelMappingError("native model request body must be a JSON object");
  }
  return value;
}

function mapGooglePath(pathname, models) {
  const match = pathname.match(
    /^(\/v1(?:beta)?\/models\/)([^/:]+)(:(?:generateContent|streamGenerateContent))$/
  );
  if (!match) throw new ModelMappingError("Google model route is invalid");
  let requested;
  try {
    requested = decodeURIComponent(match[2]);
  } catch {
    throw new ModelMappingError("Google model route contains invalid encoding");
  }
  const mapping = resolveExactModel(models, requested);
  return {
    ...mapping,
    pathname: `${match[1]}${encodeURIComponent(mapping.outbound_model)}${match[3]}`,
    body: null
  };
}

export function mapNativeModelRequest({
  protocol,
  method,
  pathname,
  body,
  models
}) {
  validateModels(models);
  if (method === "GET") {
    return {
      requested_model: null,
      outbound_model: null,
      mapped: false,
      pathname,
      body
    };
  }
  if (protocol === "google_generative") {
    const result = mapGooglePath(pathname, models);
    return { ...result, body };
  }
  if (!["anthropic_messages", "openai_responses", "openai_chat"].includes(protocol)) {
    throw new ModelMappingError(`unsupported proxy protocol '${protocol}'`);
  }
  const payload = parseJsonObject(body);
  if (payload.model !== undefined && typeof payload.model !== "string") {
    throw new ModelMappingError("native model request field 'model' must be a string");
  }
  const mapping = resolveExactModel(models, payload.model);
  payload.model = mapping.outbound_model;
  return {
    ...mapping,
    pathname,
    body: Buffer.from(JSON.stringify(payload))
  };
}
