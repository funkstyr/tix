export function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} not initialized`);
  return value;
}
