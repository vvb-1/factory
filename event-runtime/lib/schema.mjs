/**
 * Minimal JSON Schema validator — the subset the runtime's contracts actually
 * use, implemented here rather than pulled in as a dependency. Contracts fail
 * closed (docs/event-runtime.md §5): an unsupported schema keyword is an error
 * in the schema, not a silently-passing check.
 */

const SUPPORTED = new Set([
  "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "description", "title", "$schema",
]);

/**
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(schema, value, path = "$") {
  const errors = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(declared, actual) {
  return declared === actual || (declared === "number" && actual === "integer");
}

function check(schema, value, path, errors) {
  if (schema === undefined || schema === null) {
    errors.push(`${path}: schema is missing`);
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path}: schema must be an object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      errors.push(`${path}: unsupported schema keyword "${key}" — contracts fail closed`);
      return;
    }
  }

  const actual = typeOf(value);

  if (schema.type !== undefined) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.some((t) => matchesType(t, actual))) {
      errors.push(`${path}: expected type ${declared.join("|")}, got ${actual}`);
      return;
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (actual === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (actual === "integer" || actual === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (actual === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (actual === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in value) check(propSchema, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}: unknown property "${key}"`);
      }
    } else if (typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) check(schema.additionalProperties, value[key], `${path}.${key}`, errors);
      }
    }
  }
}
