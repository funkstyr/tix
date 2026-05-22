export async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop -- polling loop by design
    const value = await read();
    if (value !== undefined) return value;
    // eslint-disable-next-line no-await-in-loop -- polling loop by design
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not satisfied within ${timeoutMs}ms`);
}
