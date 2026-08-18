import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DecisionRequest, DecisionResponse } from "../types";
import { decisionRequestHash, validateDecisionResponse } from "./decision";

interface SharedCase {
  name: string;
  request: DecisionRequest;
  hash: string;
  responses: { name: string; valid: boolean; value: DecisionResponse }[];
}

const cases = JSON.parse(
  readFileSync(
    new URL("../../../lib/fixtures/decision-cases.json", import.meta.url),
    "utf8",
  ),
).cases as SharedCase[];

describe("browser decision port", () => {
  test("agrees with the server fixture hashes and response verdicts", () => {
    for (const fixture of cases) {
      expect(decisionRequestHash(fixture.request), fixture.name).toBe(
        fixture.hash,
      );
      for (const response of fixture.responses) {
        expect(
          validateDecisionResponse(response.value, fixture.request).valid,
          `${fixture.name}/${response.name}`,
        ).toBe(response.valid);
      }
    }
  });

  test("canonical key ordering does not change the hash", () => {
    const request = cases[0].request;
    const reordered = {
      options: request.options,
      question: request.question,
      fields: request.fields,
      recommended: request.recommended,
      context: request.context,
      schemaVersion: request.schemaVersion,
    } as DecisionRequest;
    expect(decisionRequestHash(reordered)).toBe(decisionRequestHash(request));
  });

  test("malformed choice fields return invalid instead of throwing", () => {
    const malformed = structuredClone(cases[0].request) as unknown as {
      fields: Record<string, unknown>[];
    };
    malformed.fields[1] = {
      id: "paths",
      kind: "multi-choice",
      label: "Paths",
    };
    const response = cases[0].responses[0].value;
    expect(() =>
      validateDecisionResponse(
        response,
        malformed as unknown as DecisionRequest,
      ),
    ).not.toThrow();
    expect(
      validateDecisionResponse(
        response,
        malformed as unknown as DecisionRequest,
      ).valid,
    ).toBe(false);
  });
});
