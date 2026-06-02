import { LogLevel } from "effect";

// Map the `LOG_LEVEL` env (ADR-0012 Tier 3) onto an Effect `LogLevel`. Effect's level tags are
// capitalized (Info / Warning / …); we accept the conventional lowercase env spellings plus `warn`
// as an alias for `warning` (the ADR's prod spelling). Reading is case- and whitespace-insensitive.
const LEVELS: Record<string, LogLevel.LogLevel> = {
  all: LogLevel.All,
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warning,
  warning: LogLevel.Warning,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
  none: LogLevel.None,
};

// Unset or unrecognized falls back to Info — the ADR default — so a typo degrades to the safe
// verbose-enough baseline rather than silencing logs. Reading the env here (not via Effect `Config`)
// keeps the observability layer's error channel `never`: booting never depends on a parseable env.
export function logLevelFromEnv(raw: string | undefined): LogLevel.LogLevel {
  if (raw === undefined) return LogLevel.Info;

  return LEVELS[raw.trim().toLowerCase()] ?? LogLevel.Info;
}
