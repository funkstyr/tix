import { makeAuthClient, makeTicketsClient } from "@tix/saga-client/clients";

import { parseCatalogSeedEnv } from "./config.ts";
import { ensureCatalog } from "./seed-catalog.ts";

// One-shot: sign the standing seller in, then idempotently ensure the curated anchor catalog is
// listed, then exit. Run as a dev-only Job after tickets+auth are up (gated with the loadgen). The
// seller account itself is provisioned by the always-on `synthetic-seed` Job; this only lists
// tickets, so it assumes that account exists and signs in (failing loudly if it doesn't).
const env = parseCatalogSeedEnv();

const auth = makeAuthClient(env.authBaseUrl);
const tickets = makeTicketsClient(env.ticketsBaseUrl);

auth
  .signIn(env.seller)
  .then((seller) => ensureCatalog(tickets, seller.token))
  .then((outcomes) => {
    for (const outcome of outcomes) {
      console.log(`catalog seed: ${outcome.title} ${outcome.status}`);
    }
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("catalog seed failed", { err });
    process.exit(1);
  });
