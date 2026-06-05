import { expect, test } from "@playwright/test";

import { randomSuffix } from "../src/seed.ts";

test("seller signs up, lists a ticket, and sees it on the listings page", async ({ page }) => {
  const email = `seller-${randomSuffix()}@e2e.test`;
  const title = `Test show ${randomSuffix()}`;

  await page.goto("/auth/signup");

  await page.getByLabel("Name").fill("Test Seller");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();

  // Header swaps to the signed-in slot once auth state settles.
  await expect(page.getByTestId("current-user")).toHaveText(email);

  await page.getByRole("navigation").getByRole("link", { name: "List a ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/new$/);

  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Price").fill("25");
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "List ticket" }).click();

  // Submit redirects to /tickets/$ticketId on success.
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);

  await page.goto("/tickets");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();

  // Inventory view: the seller's own listings should show remaining of total.
  // Only one row in this fixture, so the my-ticket-quantity test id picks it
  // out unambiguously.
  await page.getByRole("link", { name: "My tickets" }).click();
  await expect(page).toHaveURL(/\/tickets\/mine$/);
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await expect(page.getByTestId("my-ticket-quantity")).toHaveText("3 of 3 remaining");
});

test("seller edits a listed ticket's title and price", async ({ page }) => {
  const email = `seller-${randomSuffix()}@e2e.test`;
  const title = `Editable show ${randomSuffix()}`;
  const newTitle = `${title} (rescheduled)`;

  await page.goto("/auth/signup");

  await page.getByLabel("Name").fill("Edit Seller");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("current-user")).toHaveText(email);

  await page.getByRole("navigation").getByRole("link", { name: "List a ticket" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Price").fill("25");
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "List ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);

  // The owner sees an Edit affordance on their own listing; a buyer would see
  // the Buy button here instead.
  const editLink = page.getByRole("link", { name: "Edit" });
  await expect(editLink).toBeVisible();
  await editLink.click();
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}\/edit$/);

  // The form is prefilled from the existing ticket.
  await expect(page.getByLabel("Title")).toHaveValue(title);
  expect(Number(await page.getByLabel("Price").inputValue())).toBe(25);

  await page.getByLabel("Title").fill(newTitle);
  await page.getByLabel("Price").fill("30");
  await page.getByRole("button", { name: "Save changes" }).click();

  // Save redirects back to the detail page, which re-reads the authoritative
  // ticket row and shows the edited title and price.
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: newTitle })).toBeVisible();
  await expect(page.getByText("$30.00")).toBeVisible();
});
