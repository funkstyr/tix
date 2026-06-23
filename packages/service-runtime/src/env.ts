import { ArkErrors } from "arktype";

// Parses an env record against an arktype schema, throwing the uniform
// "invalid environment: <summary>" error every service raises today. The schema
// itself stays in the service — shapes genuinely differ; only this machinery
// is shared.
export function parseEnvSchema<T>(
  schema: (env: Record<string, string | undefined>) => T | ArkErrors,
  env: Record<string, string | undefined>,
): T {
  const parsed = schema(env);
  if (parsed instanceof ArkErrors) {
    throw new Error(`invalid environment: ${parsed.summary}`);
  }
  return parsed;
}

export function requirePort(value: number | undefined, fallback: number, name: string): number {
  const port = value ?? fallback;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid ${name}: ${port}`);
  }
  return port;
}

export function requirePositiveInt(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: ${parsed}`);
  }
  return parsed;
}
