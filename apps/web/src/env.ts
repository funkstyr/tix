import { ArkErrors, type } from "arktype";

const envSchema = type({
  VITE_GATEWAY_URL: "string.url",
  VITE_STRIPE_PK: "string >= 1",
  "VITE_RUM_URL?": "string.url",
  "VITE_RUM_APP_NAME?": "string >= 1",
  "VITE_RUM_SAMPLE_RATE?": "string >= 1",
});

export type WebEnv = typeof envSchema.infer;

export function parseEnv(env: Record<string, unknown>): WebEnv {
  const parsed = envSchema(env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid web environment: ${parsed.summary}`);
  }

  return parsed;
}
