import { makeAuthClient } from "@tix/saga-client/clients";

import { parseSeedEnv } from "./config.ts";
import { ensureAccounts, type SeedAccount } from "./seed.ts";

// One-shot: idempotently provision the probe's standing seller + buyer accounts, then exit. Run as
// a Job on deploy (before the CronJob's first tick) so a fresh auth DB doesn't make every journey
// fail at sign-in. No OTel runtime — this is a deploy-time bootstrap, not a probe, so it carries no
// metrics/spans; plain console output is enough for a Job's logs.
const env = parseSeedEnv();

const accounts: SeedAccount[] = [
  { email: env.seller.email, password: env.seller.password, name: "Synthetic Seller" },
  { email: env.buyer.email, password: env.buyer.password, name: "Synthetic Buyer" },
];

ensureAccounts(makeAuthClient(env.authBaseUrl), accounts)
  .then((outcomes) => {
    for (const outcome of outcomes) {
      console.log(`synthetic seed: ${outcome.email} ${outcome.status}`);
    }
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("synthetic seed failed", { err });
    process.exit(1);
  });
