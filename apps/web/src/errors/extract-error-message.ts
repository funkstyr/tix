export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message;

  return fallback;
}
