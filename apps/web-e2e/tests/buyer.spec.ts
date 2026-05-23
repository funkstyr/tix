import { expect, test } from "@playwright/test";

import { randomSuffix, seedTicket } from "../src/seed.ts";

// Stripe test fixtures — these are the public, documented values for test
// mode (https://stripe.com/docs/testing). Lifted to constants so any future
// "what card did we use?" search lands here.
const STRIPE_TEST_CARD = "4242 4242 4242 4242";
const STRIPE_TEST_EXPIRY = "12 / 34";
const STRIPE_TEST_CVC = "123";
const STRIPE_TEST_ZIP = "12345";

// Skip when STRIPE_TEST_KEY is missing: without a real sandbox key, the
// payments service runs against a stub and the PaymentElement iframe can't
// be exercised end-to-end. The seller spec still runs in this mode.
test.skip(
  process.env["STRIPE_TEST_KEY"] === undefined || process.env["STRIPE_TEST_KEY"].length === 0,
  "STRIPE_TEST_KEY unset — Buyer spec needs a real Stripe sandbox key",
);

test("buyer signs up, buys a ticket, pays with a Stripe test card, sees Order complete", async ({
  page,
}) => {
  const gatewayUrl = process.env["WEB_E2E_GATEWAY_URL"];
  if (gatewayUrl === undefined) {
    throw new Error("WEB_E2E_GATEWAY_URL must be set by global-setup");
  }

  const title = `Buyer test show ${randomSuffix()}`;
  const { ticket } = await seedTicket(gatewayUrl, {
    title,
    quantityTotal: 2,
    unitPriceCents: 4_500,
  });

  const buyerEmail = `buyer-${randomSuffix()}@e2e.test`;

  await page.goto("/auth/signup");
  await page.getByLabel("Name").fill("Test Buyer");
  await page.getByLabel("Email").fill(buyerEmail);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("current-user")).toHaveText(buyerEmail);

  await page.goto("/tickets");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(new RegExp(`/tickets/${ticket.id}$`));

  await page.getByRole("button", { name: "Buy" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

  // Stripe's PaymentElement renders inside a same-origin proxy iframe. The
  // card-number input lives one level deeper, in the cross-origin frame the
  // proxy hosts — Playwright walks both frames transparently via
  // frameLocator chaining.
  const paymentFrame = page.frameLocator(
    'iframe[name^="__privateStripeFrame"], iframe[title="Secure payment input frame"]',
  );

  // The Element is asynchronously hydrated by Stripe.js. Wait for the card
  // input to be present before typing, otherwise the first keystrokes get
  // dropped on the floor.
  const cardNumber = paymentFrame.getByRole("textbox", { name: /card number/i });
  await cardNumber.waitFor({ state: "visible", timeout: 30_000 });
  await cardNumber.fill(STRIPE_TEST_CARD);
  await paymentFrame.getByRole("textbox", { name: /expiration/i }).fill(STRIPE_TEST_EXPIRY);
  await paymentFrame.getByRole("textbox", { name: /cvc|security code/i }).fill(STRIPE_TEST_CVC);

  // Postal code is requested only for some locales; fill if present.
  const zip = paymentFrame.getByRole("textbox", { name: /zip|postal/i });
  if ((await zip.count()) > 0) {
    await zip.fill(STRIPE_TEST_ZIP);
  }

  await page.getByRole("button", { name: "Pay" }).click();

  // Successful payment routes back to /orders. The Order may still be
  // `awaiting_payment` for a beat while the `payment.created.v1` consumer
  // applies the FSM transition; reload until the list shows `complete`.
  await expect(page).toHaveURL(/\/orders\/?$/);

  await expect
    .poll(
      async () => {
        await page.reload();
        const statuses = await page.getByTestId("order-status").allTextContents();
        return statuses;
      },
      {
        message: "order never reached complete",
        timeout: 30_000,
        intervals: [1_000, 2_000, 3_000],
      },
    )
    .toContain("complete");
});
