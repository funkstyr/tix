// Minimal surface of @pyroscope/nodejs we depend on. Declared locally so the unit test can
// inject a stub and so a future SDK reshuffle is a one-line change here.
export type PyroscopeLike = {
  init: (config: {
    appName: string;
    serverAddress: string;
    tags: Record<string, string>;
  }) => void;
  start: () => void;
};

export type StartProfilingOptions = {
  serviceName: string;
  // Deploy/build version, surfaced as the service_version tag so a flame graph correlates with
  // the trace/span service.version resource attribute (ADR-0009/0010).
  version: string;
  env: Record<string, string | undefined>;
  pyroscope: PyroscopeLike;
};

// Opt-in continuous profiling. Off unless PROFILING_ENABLED is truthy AND a server address is
// set — so tests, CI, and any unconfigured environment never start the profiler. Tags mirror
// the OTel resource attributes (service_name/service_version) so Grafana can pivot trace<->profile.
export function startProfiling(opts: StartProfilingOptions): void {
  const enabled = opts.env["PROFILING_ENABLED"] === "true";
  const serverAddress = opts.env["PYROSCOPE_SERVER_ADDRESS"];
  if (!enabled || !serverAddress) return;

  opts.pyroscope.init({
    appName: opts.serviceName,
    serverAddress,
    tags: { service_name: opts.serviceName, service_version: opts.version },
  });
  opts.pyroscope.start();
}
