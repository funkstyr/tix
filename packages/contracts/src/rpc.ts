export const RPC_PREFIX = "/rpc";

export function joinRpcUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${RPC_PREFIX}`;
}
