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

  await page.getByRole("link", { name: "List a ticket" }).click();
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
  // No other seller signed up in this test, so a direct match on the global
  // remaining-of-total label is unambiguous.
  await page.getByRole("link", { name: "My tickets" }).click();
  await expect(page).toHaveURL(/\/tickets\/mine$/);
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await expect(page.getByTestId("my-ticket-quantity")).toHaveText("3 of 3 remaining");
});
