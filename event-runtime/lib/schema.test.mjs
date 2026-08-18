import { describe, expect, test } from "bun:test";
import { validate } from "./schema.mjs";

describe("validate", () => {
  test("accepts a conforming object", () => {
    const schema = {
      type: "object",
      required: ["name", "count"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0 },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(
      validate(schema, { name: "bj29", count: 2, tags: ["a"] }).valid,
    ).toBe(true);
  });

  test("rejects unknown properties when additionalProperties is false", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    const { valid, errors } = validate(schema, { a: "x", extra: 1 });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('"extra"');
  });

  test("integer is a number, but number is not an integer", () => {
    expect(validate({ type: "number" }, 1).valid).toBe(true);
    expect(validate({ type: "integer" }, 1.5).valid).toBe(false);
  });

  test("supports type arrays (nullable fields)", () => {
    expect(validate({ type: ["string", "null"] }, null).valid).toBe(true);
    expect(validate({ type: ["string", "null"] }, 5).valid).toBe(false);
  });

  test("const, enum, pattern, bounds", () => {
    expect(
      validate({ const: "factory.event/v1" }, "factory.event/v1").valid,
    ).toBe(true);
    expect(validate({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validate({ type: "string", pattern: "^run_" }, "prop_1").valid).toBe(
      false,
    );
    expect(validate({ type: "array", minItems: 1 }, []).valid).toBe(false);
  });

  test("empty schema accepts anything", () => {
    expect(validate({}, { any: ["thing", 1, null] }).valid).toBe(true);
  });

  test("unsupported keywords fail closed", () => {
    const { valid, errors } = validate({ anyOf: [{ type: "string" }] }, "x");
    expect(valid).toBe(false);
    expect(errors[0]).toContain("unsupported schema keyword");
  });

  test("nested errors carry a path", () => {
    const schema = {
      type: "object",
      properties: {
        repos: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    const { errors } = validate(schema, { repos: [{}] });
    expect(errors[0]).toContain("$.repos[0]");
  });

  describe("prototype-inherited keys and pollution (OPS-438)", () => {
    test("rejects prototype-inherited keys when additionalProperties is false", () => {
      const schema = {
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "string" } },
      };
      expect(validate(schema, { a: "x", toString: "evil" }).valid).toBe(false);
      expect(validate(schema, { a: "x", valueOf: "evil" }).valid).toBe(false);
      expect(validate(schema, { a: "x", constructor: "evil" }).valid).toBe(
        false,
      );
      expect(validate(schema, { a: "x", isPrototypeOf: "evil" }).valid).toBe(
        false,
      );
    });

    test("validates additionalProperties schema on prototype-named own keys", () => {
      const schema = {
        type: "object",
        additionalProperties: { type: "integer" },
        properties: { a: { type: "string" } },
      };
      const res = validate(schema, { a: "x", toString: "not-an-int" });
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("$.toString");
    });

    test("rejects missing required property even if name matches Object.prototype method", () => {
      const schema = {
        type: "object",
        required: ["toString", "valueOf", "constructor"],
      };
      const res = validate(schema, {});
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBe(3);
      expect(res.errors.some((e) => e.includes('"toString"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"valueOf"'))).toBe(true);
      expect(res.errors.some((e) => e.includes('"constructor"'))).toBe(true);
    });

    test("does not validate schema against prototype methods when property is absent on value", () => {
      const schema = {
        type: "object",
        properties: {
          toString: { type: "string" },
          valueOf: { type: "string" },
        },
      };
      const res = validate(schema, {});
      expect(res.valid).toBe(true);
    });

    test("validates objects created with Object.create(null)", () => {
      const schema = {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
        },
      };
      const obj = Object.create(null);
      obj.name = "safe";
      expect(validate(schema, obj).valid).toBe(true);

      const invalidObj = Object.create(null);
      invalidObj.extra = "bad";
      expect(validate(schema, invalidObj).valid).toBe(false);
    });

    test("schema does not pick up polluted prototype properties", () => {
      try {
        Object.prototype.unsupportedCustomKeyword = "polluted";
        Object.prototype.minimum = 100;
        const schema = { type: "number" };
        expect(validate(schema, 5).valid).toBe(true);
      } finally {
        delete Object.prototype.unsupportedCustomKeyword;
        delete Object.prototype.minimum;
      }
    });
  });
});
