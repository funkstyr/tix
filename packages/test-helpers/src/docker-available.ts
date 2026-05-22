import { existsSync } from "node:fs";

// True when a Docker engine looks reachable from this machine — checked via
// `DOCKER_HOST` first, then the common per-driver socket paths. Used by
// integration tests to gate testcontainers-based suites so the rest of
// `pnpm test` stays green on machines without Docker.
export const dockerAvailable: boolean = ((): boolean => {
  if (process.env["DOCKER_HOST"]) return true;
  const home = process.env["HOME"] ?? "";
  const candidates = [
    "/var/run/docker.sock",
    `${home}/.docker/run/docker.sock`,
    `${home}/.colima/default/docker.sock`,
    `${home}/.orbstack/run/docker.sock`,
  ];
  return candidates.some((p) => existsSync(p));
})();
