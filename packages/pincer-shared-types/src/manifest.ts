export type ManifestHttpMethod = "GET" | "POST";
export type ManifestRequestMode = "query" | "json";
export type ManifestAuthPlacement = "header" | "query";

export type ActionLimits = {
  maxBodyKb: number;
  timeoutMs: number;
  ratePerMinute: number;
};

export type ActionAuth = {
  placement: ManifestAuthPlacement;
  name: string;
  secretBinding: string;
  prefix?: string;
};

export type AdapterInputPropertyType = "string" | "integer" | "number" | "boolean";

export type AdapterInputPropertySchema = {
  type: AdapterInputPropertyType;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: Array<string | number | boolean>;
};

export type AdapterInputSchema = {
  type: "object";
  properties?: Record<string, AdapterInputPropertySchema>;
  required?: string[];
  additionalProperties?: boolean;
};

export type AdapterManifestAction = {
  method: ManifestHttpMethod;
  path: string;
  requestMode: ManifestRequestMode;
  auth: ActionAuth;
  limits: ActionLimits;
  inputSchema: AdapterInputSchema;
};

export type AdapterManifest = {
  id: string;
  revision: number;
  baseUrl: string;
  allowedHosts: string[];
  requiredSecrets: string[];
  actions: Record<string, AdapterManifestAction>;
};

export type ManifestValidationFailure = {
  ok: false;
  errors: string[];
};

export type ManifestValidationSuccess = {
  ok: true;
  manifest: AdapterManifest;
};

export type ManifestValidationResult = ManifestValidationFailure | ManifestValidationSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInt(value: unknown, field: string, errors: string[]): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    errors.push(`${field}: must be a positive integer`);
    return 0;
  }

  return value as number;
}

function parseUrl(value: unknown, field: string, errors: string[]): URL | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field}: must be a non-empty string`);
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    errors.push(`${field}: must be a valid URL`);
    return null;
  }

  if (parsed.protocol !== "https:") {
    errors.push(`${field}: only https URLs are allowed`);
    return null;
  }

  return parsed;
}

function validateHost(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field}: must be a non-empty string`);
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.includes("*")) {
    errors.push(`${field}: wildcard hosts are not allowed`);
    return "";
  }

  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(normalized)) {
    errors.push(`${field}: invalid host format`);
    return "";
  }

  return normalized;
}

function validateKeyName(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field}: must be a non-empty string`);
    return "";
  }

  const normalized = value.trim();
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(normalized)) {
    errors.push(`${field}: must match ^[A-Z][A-Z0-9_]{1,127}$`);
    return "";
  }

  return normalized;
}

function validateActionName(value: string, field: string, errors: string[]): string {
  if (!/^[a-z0-9][a-z0-9_]{1,63}$/.test(value)) {
    errors.push(`${field}: must match ^[a-z0-9][a-z0-9_]{1,63}$`);
    return "";
  }

  return value;
}

function validateInputPropertySchema(
  raw: unknown,
  field: string,
  errors: string[]
): AdapterInputPropertySchema | null {
  if (!isRecord(raw)) {
    errors.push(`${field}: must be an object`);
    return null;
  }

  const type = raw.type;
  if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") {
    errors.push(`${field}.type: must be string|integer|number|boolean`);
    return null;
  }

  const schema: AdapterInputPropertySchema = { type };

  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) {
      errors.push(`${field}.enum: must be a non-empty array`);
    } else {
      schema.enum = raw.enum as Array<string | number | boolean>;
    }
  }

  if (type === "string") {
    if (raw.minLength !== undefined) {
      if (!Number.isInteger(raw.minLength) || (raw.minLength as number) < 0) {
        errors.push(`${field}.minLength: must be an integer >= 0`);
      } else {
        schema.minLength = raw.minLength as number;
      }
    }

    if (raw.maxLength !== undefined) {
      if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 0) {
        errors.push(`${field}.maxLength: must be an integer >= 0`);
      } else {
        schema.maxLength = raw.maxLength as number;
      }
    }

    if (
      schema.minLength !== undefined &&
      schema.maxLength !== undefined &&
      schema.maxLength < schema.minLength
    ) {
      errors.push(`${field}: maxLength must be >= minLength`);
    }
  }

  if (type === "integer" || type === "number") {
    if (raw.minimum !== undefined) {
      if (typeof raw.minimum !== "number" || !Number.isFinite(raw.minimum)) {
        errors.push(`${field}.minimum: must be a finite number`);
      } else {
        schema.minimum = raw.minimum;
      }
    }

    if (raw.maximum !== undefined) {
      if (typeof raw.maximum !== "number" || !Number.isFinite(raw.maximum)) {
        errors.push(`${field}.maximum: must be a finite number`);
      } else {
        schema.maximum = raw.maximum;
      }
    }

    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.maximum < schema.minimum
    ) {
      errors.push(`${field}: maximum must be >= minimum`);
    }
  }

  return schema;
}

function validateInputSchema(raw: unknown, field: string, errors: string[]): AdapterInputSchema | null {
  if (!isRecord(raw)) {
    errors.push(`${field}: must be an object`);
    return null;
  }

  if (raw.type !== "object") {
    errors.push(`${field}.type: must be 'object'`);
    return null;
  }

  const schema: AdapterInputSchema = { type: "object" };

  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== "boolean") {
      errors.push(`${field}.additionalProperties: must be boolean`);
    } else {
      schema.additionalProperties = raw.additionalProperties;
    }
  }

  const propertiesRaw = raw.properties;
  if (propertiesRaw !== undefined) {
    if (!isRecord(propertiesRaw)) {
      errors.push(`${field}.properties: must be an object`);
    } else {
      const properties: Record<string, AdapterInputPropertySchema> = {};
      for (const [propName, propSchemaRaw] of Object.entries(propertiesRaw)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(propName)) {
          errors.push(`${field}.properties.${propName}: invalid property name`);
          continue;
        }

        const parsedProperty = validateInputPropertySchema(
          propSchemaRaw,
          `${field}.properties.${propName}`,
          errors
        );
        if (parsedProperty) {
          properties[propName] = parsedProperty;
        }
      }
      schema.properties = properties;
    }
  }

  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) {
      errors.push(`${field}.required: must be an array`);
    } else {
      const required: string[] = [];
      const seen = new Set<string>();
      for (const [idx, item] of raw.required.entries()) {
        if (typeof item !== "string" || item.length === 0) {
          errors.push(`${field}.required[${idx}]: must be a non-empty string`);
          continue;
        }

        if (!seen.has(item)) {
          seen.add(item);
          required.push(item);
        }
      }
      schema.required = required;
    }
  }

  return schema;
}

function validateAction(raw: unknown, field: string, errors: string[]): AdapterManifestAction | null {
  if (!isRecord(raw)) {
    errors.push(`${field}: must be an object`);
    return null;
  }

  const method = raw.method;
  if (method !== "GET" && method !== "POST") {
    errors.push(`${field}.method: must be GET or POST`);
  }

  const path = raw.path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    errors.push(`${field}.path: must be an absolute path`);
  }

  const requestMode = raw.requestMode;
  if (requestMode !== "query" && requestMode !== "json") {
    errors.push(`${field}.requestMode: must be query or json`);
  }

  const authRaw = raw.auth;
  let auth: ActionAuth | null = null;
  if (!isRecord(authRaw)) {
    errors.push(`${field}.auth: must be an object`);
  } else {
    const placement = authRaw.placement;
    if (placement !== "header" && placement !== "query") {
      errors.push(`${field}.auth.placement: must be header or query`);
    }

    const authName = authRaw.name;
    if (typeof authName !== "string" || authName.trim().length === 0) {
      errors.push(`${field}.auth.name: must be a non-empty string`);
    }

    const secretBinding = validateKeyName(
      authRaw.secretBinding,
      `${field}.auth.secretBinding`,
      errors
    );

    let prefix: string | undefined;
    if (authRaw.prefix !== undefined) {
      if (typeof authRaw.prefix !== "string") {
        errors.push(`${field}.auth.prefix: must be a string`);
      } else {
        prefix = authRaw.prefix;
      }
    }

    if ((placement === "header" || placement === "query") && typeof authName === "string" && secretBinding) {
      auth = {
        placement,
        name: authName,
        secretBinding,
        prefix,
      };
    }
  }

  const limitsRaw = raw.limits;
  let limits: ActionLimits | null = null;
  if (!isRecord(limitsRaw)) {
    errors.push(`${field}.limits: must be an object`);
  } else {
    const maxBodyKb = parsePositiveInt(limitsRaw.maxBodyKb, `${field}.limits.maxBodyKb`, errors);
    const timeoutMs = parsePositiveInt(limitsRaw.timeoutMs, `${field}.limits.timeoutMs`, errors);
    const ratePerMinute = parsePositiveInt(
      limitsRaw.ratePerMinute,
      `${field}.limits.ratePerMinute`,
      errors
    );

    if (maxBodyKb > 0 && maxBodyKb > 1024) {
      errors.push(`${field}.limits.maxBodyKb: must be <= 1024`);
    }

    if (timeoutMs > 0 && timeoutMs > 120_000) {
      errors.push(`${field}.limits.timeoutMs: must be <= 120000`);
    }

    if (ratePerMinute > 0 && ratePerMinute > 100_000) {
      errors.push(`${field}.limits.ratePerMinute: must be <= 100000`);
    }

    if (maxBodyKb > 0 && timeoutMs > 0 && ratePerMinute > 0) {
      limits = { maxBodyKb, timeoutMs, ratePerMinute };
    }
  }

  const inputSchema = validateInputSchema(raw.inputSchema, `${field}.inputSchema`, errors);

  if (!auth || !limits || !inputSchema || (method !== "GET" && method !== "POST") || (requestMode !== "query" && requestMode !== "json") || typeof path !== "string") {
    return null;
  }

  return {
    method,
    path,
    requestMode,
    auth,
    limits,
    inputSchema,
  };
}

export function validateAdapterManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: ["manifest: must be a JSON object"],
    };
  }

  const idRaw = raw.id;
  let id = "";
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    errors.push("manifest.id: must be a non-empty string");
  } else {
    id = idRaw.trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
      errors.push("manifest.id: must match ^[a-z0-9][a-z0-9_-]{1,63}$");
    }
  }

  const revision = parsePositiveInt(raw.revision, "manifest.revision", errors);
  const baseUrl = parseUrl(raw.baseUrl, "manifest.baseUrl", errors);

  const allowedHostsRaw = raw.allowedHosts;
  const allowedHosts: string[] = [];
  if (!Array.isArray(allowedHostsRaw) || allowedHostsRaw.length === 0) {
    errors.push("manifest.allowedHosts: must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [idx, hostRaw] of allowedHostsRaw.entries()) {
      const parsed = validateHost(hostRaw, `manifest.allowedHosts[${idx}]`, errors);
      if (!parsed || seen.has(parsed)) {
        continue;
      }
      seen.add(parsed);
      allowedHosts.push(parsed);
    }
  }

  if (baseUrl && allowedHosts.length > 0 && !allowedHosts.includes(baseUrl.host.toLowerCase())) {
    errors.push("manifest.allowedHosts: must include baseUrl host");
  }

  const requiredSecretsRaw = raw.requiredSecrets;
  const requiredSecrets: string[] = [];
  if (!Array.isArray(requiredSecretsRaw)) {
    errors.push("manifest.requiredSecrets: must be an array");
  } else {
    const seen = new Set<string>();
    for (const [idx, secretRaw] of requiredSecretsRaw.entries()) {
      const parsed = validateKeyName(secretRaw, `manifest.requiredSecrets[${idx}]`, errors);
      if (!parsed || seen.has(parsed)) {
        continue;
      }
      seen.add(parsed);
      requiredSecrets.push(parsed);
    }
  }

  const actionsRaw = raw.actions;
  const actions: Record<string, AdapterManifestAction> = {};
  if (!isRecord(actionsRaw) || Object.keys(actionsRaw).length === 0) {
    errors.push("manifest.actions: must be a non-empty object");
  } else {
    for (const [actionNameRaw, actionRaw] of Object.entries(actionsRaw)) {
      const actionName = validateActionName(actionNameRaw, `manifest.actions.${actionNameRaw}`, errors);
      if (!actionName) {
        continue;
      }

      const parsedAction = validateAction(actionRaw, `manifest.actions.${actionName}`, errors);
      if (parsedAction) {
        actions[actionName] = parsedAction;
      }
    }
  }

  for (const [actionName, action] of Object.entries(actions)) {
    if (!requiredSecrets.includes(action.auth.secretBinding)) {
      errors.push(
        `manifest.actions.${actionName}.auth.secretBinding: must be listed in requiredSecrets`
      );
    }

    if (baseUrl) {
      try {
        const resolved = new URL(action.path, baseUrl);
        if (resolved.protocol !== "https:") {
          errors.push(`manifest.actions.${actionName}.path: resolved URL must be https`);
        }

        if (!allowedHosts.includes(resolved.host.toLowerCase())) {
          errors.push(`manifest.actions.${actionName}.path: resolved host not in allowedHosts`);
        }
      } catch {
        errors.push(`manifest.actions.${actionName}.path: could not resolve URL`);
      }
    }
  }

  if (errors.length > 0 || !baseUrl) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    manifest: {
      id,
      revision,
      baseUrl: baseUrl.toString(),
      allowedHosts,
      requiredSecrets,
      actions,
    },
  };
}

function validateValueByPropertySchema(
  value: unknown,
  field: string,
  schema: AdapterInputPropertySchema,
  errors: string[]
): void {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${field}: expected string`);
      return;
    }

    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${field}: expected minLength ${schema.minLength}`);
    }

    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${field}: expected maxLength ${schema.maxLength}`);
    }
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`${field}: expected integer`);
      return;
    }

    const numeric = value as number;
    if (schema.minimum !== undefined && numeric < schema.minimum) {
      errors.push(`${field}: expected >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && numeric > schema.maximum) {
      errors.push(`${field}: expected <= ${schema.maximum}`);
    }
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${field}: expected number`);
      return;
    }

    const numeric = value as number;
    if (schema.minimum !== undefined && numeric < schema.minimum) {
      errors.push(`${field}: expected >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && numeric > schema.maximum) {
      errors.push(`${field}: expected <= ${schema.maximum}`);
    }
  }

  if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${field}: expected boolean`);
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    errors.push(`${field}: value not in enum`);
  }
}

export function validateInputWithSchema(
  input: Record<string, unknown>,
  schema: AdapterInputSchema
): string[] {
  const errors: string[] = [];

  const properties = schema.properties || {};
  const required = schema.required || [];

  for (const requiredKey of required) {
    if (!(requiredKey in input)) {
      errors.push(`input.${requiredKey}: missing required property`);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === true) {
        continue;
      }

      errors.push(`input.${key}: property is not allowed`);
      continue;
    }

    validateValueByPropertySchema(value, `input.${key}`, propertySchema, errors);
  }

  return errors;
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSort(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableSort(value[key]);
  }
  return sorted;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableSort(value));
}
