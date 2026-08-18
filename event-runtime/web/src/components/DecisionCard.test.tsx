import "../test-dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "../api";
import type { DecisionRequest, InboxItem } from "../types";
import { decisionRequestHash } from "../lib/decision";
import { DecisionCard } from "./DecisionCard";

const request: DecisionRequest = {
  schemaVersion: "factory.decision-request/v1",
  question:
    "WM-313 changes how the pi adapter reads FACTORY_EVENT_SECRET. May I proceed?",
  context:
    "The ticket moves secret handling from env to a file the worker mounts…\n\nRisk: a wrong path leaks the secret into the run journal.",
  recommended: "authorise",
  options: [
    {
      id: "triage",
      label: "Send back to Triage",
      description: "The ticket should be re-scoped before anyone touches this.",
      effect: "send_to_triage",
      tone: "neutral",
    },
    {
      id: "authorise",
      label: "Authorise within these paths",
      description:
        "Re-dispatch me with your approval bound to WM-313 as written now.",
      effect: "authorise",
      tone: "primary",
      scope: {
        paths: [
          "event-runtime/lib/adapters/pi.mjs",
          "event-runtime/lib/security-env.mjs",
        ],
        summary:
          "Read the event secret from FACTORY_EVENT_SECRET_FILE when set; never log its value.",
      },
    },
    { id: "dismiss", label: "Not now", effect: "dismiss", tone: "neutral" },
  ],
  fields: [
    {
      id: "insight",
      kind: "text",
      label: "Anything I should know before I start",
      placeholder: "e.g. the file path convention, or a test to add",
      required: false,
      maxLength: 2000,
    },
    {
      id: "paths",
      kind: "multi-choice",
      label: "Restrict me to",
      choices: [
        { id: "pi", label: "event-runtime/lib/adapters/pi.mjs" },
        { id: "env", label: "event-runtime/lib/security-env.mjs" },
      ],
      required: true,
      whenOption: ["authorise"],
    },
    {
      id: "confirm",
      kind: "confirm",
      label: "I understand this changes secret handling on every worker",
      required: true,
      whenOption: ["authorise"],
    },
  ],
};

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox_decision",
    kind: "decision_needed",
    severity: "normal",
    title: "Decision needed",
    body: null,
    refs: {},
    source: "agent:run_1",
    createdAt: "2026-08-16T12:40:00.000Z",
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    delivery: {},
    decision: request,
    response: null,
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

let apiCalls: NonNullable<
  React.ComponentProps<typeof DecisionCard>["apiCalls"]
>;

beforeEach(() => {
  apiCalls = {
    decide: mock(async () => ({
      item: item(),
      effect: { kind: "authorise", outcome: "applied" },
    })),
    get: mock(async () => ({
      item: item({
        resolvedAt: "2026-08-16T12:41:07.000Z",
        resolvedBy: "operator:authorise",
        response: {
          schemaVersion: "factory.decision-response/v1",
          requestHash: decisionRequestHash(request),
          optionId: "authorise",
          fields: { paths: ["pi"], confirm: true },
          decidedBy: "operator",
          decidedAt: "2026-08-16T12:41:07.000Z",
          effect: { kind: "authorise", outcome: "applied" },
        },
      }),
    })),
    retry: mock(async () => ({
      item: item(),
      effect: { kind: "authorise", outcome: "applied" },
    })),
  };
});

afterEach(() => {
  cleanup();
});

describe("DecisionCard", () => {
  test("renders the §2.1 options recommended-first and gates its fields", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    const optionButtons = view
      .getByRole("group", { name: "Options" })
      .querySelectorAll("button");
    expect(optionButtons).toHaveLength(3);
    expect(optionButtons[0].textContent).toContain(
      "Authorise within these paths",
    );
    expect(optionButtons[0].textContent).toContain("suggested");
    expect(optionButtons[1].textContent).toContain("Send back to Triage");
    expect(optionButtons[2].textContent).toContain("Not now");
    expect(view.queryByText("Restrict me to")).toBeNull();
    expect(
      view.queryByLabelText(/I understand this changes secret handling/),
    ).toBeNull();

    fireEvent.click(optionButtons[0]);
    expect(view.getByRole("group", { name: /Restrict me to/ })).toBeTruthy();
    expect(
      view.getByLabelText(/I understand this changes secret handling/),
    ).toBeTruthy();
  });

  test("keeps submit disabled until confirmation and at least one path are chosen", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    const submit = view.getByRole("button", {
      name: "Authorise within these paths",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    expect(submit.disabled).toBe(true);
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    expect(submit.disabled).toBe(false);
  });

  test("posts the response contract then refetches before rendering the record", async () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Authorise within these paths" }),
    );

    await waitFor(() => expect(apiCalls.decide).toHaveBeenCalledTimes(1));
    expect(apiCalls.decide).toHaveBeenCalledWith("inbox_decision", {
      schemaVersion: "factory.decision-response/v1",
      requestHash: decisionRequestHash(request),
      optionId: "authorise",
      fields: { paths: ["pi"], confirm: true },
    });
    await waitFor(() => expect(apiCalls.get).toHaveBeenCalledTimes(1));
    await waitFor(() => view.getByRole("region", { name: "Decision record" }));
    expect(view.getByText("Effect applied")).toBeTruthy();
  });

  test("refetches and asks the operator to re-read a stale request", async () => {
    const changed: DecisionRequest = {
      ...request,
      question: "The scope changed. Continue?",
    };
    apiCalls.decide = mock(async () => {
      throw new ApiError("stale_request", 409);
    });
    apiCalls.get = mock(async () => ({
      item: item({ decision: changed, response: null }),
    }));
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    fireEvent.click(
      view.getByRole("group", { name: "Options" }).querySelector("button")!,
    );
    fireEvent.click(view.getByLabelText("event-runtime/lib/adapters/pi.mjs"));
    fireEvent.click(
      view.getByLabelText(/I understand this changes secret handling/),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Authorise within these paths" }),
    );
    await waitFor(() =>
      view.getByText("This question changed — please re-read"),
    );
    expect(view.getByText("The scope changed. Continue?")).toBeTruthy();
  });

  test("number keys select only from card focus, not from a text field", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        apiCalls={apiCalls}
      />,
    );
    const card = view.getByRole("region", { name: "Decision" });
    const optionButtons = view
      .getByRole("group", { name: "Options" })
      .querySelectorAll("button");
    fireEvent.keyDown(card, { key: "2" });
    expect(optionButtons[1].getAttribute("aria-pressed")).toBe("true");
    const text = view.getByLabelText("Anything I should know before I start");
    fireEvent.keyDown(text, { key: "3" });
    expect(optionButtons[1].getAttribute("aria-pressed")).toBe("true");
  });

  test("shows a failed effect and retries it before refetching the record", async () => {
    const failed = {
      schemaVersion: "factory.decision-response/v1" as const,
      requestHash: decisionRequestHash(request),
      optionId: "dismiss",
      fields: {},
      decidedBy: "operator",
      decidedAt: "2026-08-16T12:41:07.000Z",
      effect: {
        kind: "dismiss",
        outcome: "failed",
        error: "temporary failure",
      },
    };
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        response={failed}
        apiCalls={apiCalls}
      />,
    );
    expect(view.getByText(/temporary failure/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(apiCalls.retry).toHaveBeenCalledWith("inbox_decision"),
    );
    await waitFor(() =>
      expect(apiCalls.get).toHaveBeenCalledWith("inbox_decision"),
    );
  });

  test("renders an auto-superseded decision without treating it as an answer", () => {
    const view = render(
      <DecisionCard
        itemId="inbox_decision"
        request={request}
        response={{
          superseded: true,
          reason: "auto:proposal_closed",
          decidedBy: "auto:proposal_closed",
          decidedAt: "2026-08-16T12:41:07.000Z",
        }}
        apiCalls={apiCalls}
      />,
    );
    expect(
      view.getByText("This question no longer needs an answer."),
    ).toBeTruthy();
    expect(view.getByText("auto:proposal_closed")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
