import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, route: string) {
  await page.goto(`/#/${route}`);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

test("overview displays the fleet and metrics cards", async ({ page }) => {
  await open(page, "overview");

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(
    page.getByText("Intake & Approval Gate", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Execution & Fleet Capacity", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Worker Fleet Capacity/)).toBeVisible();
  await expect(
    page.getByRole("contentinfo", { name: "Status bar" }),
  ).toBeVisible();
});

test("inbox item can be inspected and acknowledged", async ({ page }) => {
  await open(page, "inbox");

  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  const firstItem = page.locator("tbody tr[aria-selected]").first();
  await expect(firstItem).toBeVisible();
  await firstItem.click();

  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toContainText("Inbox");
  await expect(page.getByText("Message", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Ack\b/ }).click();
  await expect(page.getByRole("tab", { name: /Acked/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Ack\b/ })).toHaveCount(0);
});

test("proposal opens its approval inspection modal", async ({ page }) => {
  await open(page, "proposals");

  await expect(page.getByRole("heading", { name: "Proposals" })).toBeVisible();
  const runnableProposal = page
    .locator("tbody tr[aria-selected]", { hasText: "factory-status-report@1" })
    .first();
  await expect(runnableProposal).toBeVisible();
  await runnableProposal.click();

  await expect(
    page.getByText("immutable RunSpec", { exact: true }),
  ).toBeVisible();
  const approve = page.getByRole("button", { name: /^Approve…/ });
  await expect(approve).toBeEnabled();
  await approve.click();

  const dialog = page.getByRole("dialog", {
    name: "Approve and queue this run?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("immutable spec");
  await dialog.getByRole("button", { name: "Not yet" }).click();
  await expect(dialog).toBeHidden();
});

test("run list opens execution trace and model metadata", async ({ page }) => {
  await open(page, "runs");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await page.getByRole("tab", { name: /Completed/ }).click();
  const completedRun = page.locator("tbody tr[aria-selected]").first();
  await expect(completedRun).toBeVisible();
  await completedRun.click();

  await expect(page.getByText(/^Trace(?: · \d+)?$/)).toBeVisible();
  await expect(page.getByText("model", { exact: true })).toBeVisible();
  await expect(page.getByText("n/a", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Expand/ })).toBeVisible();
});

test("graph renders the capability hierarchy without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await open(page, "graph");

  await expect(page.getByRole("heading", { name: "Graph" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Graph legend" })).toBeVisible();
  const nodes = page.locator('.react-flow__node [role="button"][aria-label]');
  await expect(nodes.first()).toBeVisible();
  expect(await nodes.count()).toBeGreaterThan(4);
  await page
    .getByRole("textbox", { name: "Search graph nodes" })
    .fill("status-report");
  await expect(page.locator('[data-search-hit="true"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});
