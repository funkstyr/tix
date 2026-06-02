import { Effect, Logger, LogLevel } from "effect";
import { describe, expect, it } from "vitest";

import { logLevelFromEnv } from "./log-level.ts";

describe("logLevelFromEnv", () => {
  it("defaults to Info when LOG_LEVEL is unset", () => {
    expect(logLevelFromEnv(undefined)).toBe(LogLevel.Info);
  });

  it("maps the conventional lowercase level names", () => {
    expect(logLevelFromEnv("debug")).toBe(LogLevel.Debug);
    expect(logLevelFromEnv("info")).toBe(LogLevel.Info);
    expect(logLevelFromEnv("error")).toBe(LogLevel.Error);
  });

  it("accepts `warn` as an alias for Warning (the ADR's prod spelling)", () => {
    expect(logLevelFromEnv("warn")).toBe(LogLevel.Warning);
    expect(logLevelFromEnv("warning")).toBe(LogLevel.Warning);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(logLevelFromEnv("  WARN ")).toBe(LogLevel.Warning);
  });

  it("falls back to Info on an unrecognized value so a typo never silences logs", () => {
    expect(logLevelFromEnv("verbose")).toBe(LogLevel.Info);
    expect(logLevelFromEnv("")).toBe(LogLevel.Info);
  });
});

// Run all four log levels under a captured logger at the given minimum, returning the messages that
// survived the filter — proving the wiring `makeObservabilityLayer` feeds actually gates output.
const captureMessages = (level: LogLevel.LogLevel) =>
  Effect.gen(function* () {
    const seen: string[] = [];

    const capture = Logger.make<unknown, void>(({ message }) => {
      seen.push(String(message));
    });

    yield* Effect.gen(function* () {
      yield* Effect.logDebug("debug-line");
      yield* Effect.logInfo("info-line");
      yield* Effect.logWarning("warn-line");
      yield* Effect.logError("error-line");
    }).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, capture)),
      Effect.provide(Logger.minimumLogLevel(level)),
    );

    return seen;
  });

describe("minimum-log-level filtering (the wiring this parser feeds)", () => {
  it("at `warn`, drops debug + info and keeps warn + error", async () => {
    const seen = await Effect.runPromise(captureMessages(logLevelFromEnv("warn")));

    expect(seen).toEqual(["warn-line", "error-line"]);
  });

  it("at the `info` default, drops debug and keeps info-and-above", async () => {
    const seen = await Effect.runPromise(captureMessages(logLevelFromEnv(undefined)));

    expect(seen).toEqual(["info-line", "warn-line", "error-line"]);
  });

  it("at `debug`, keeps every line", async () => {
    const seen = await Effect.runPromise(captureMessages(logLevelFromEnv("debug")));

    expect(seen).toEqual(["debug-line", "info-line", "warn-line", "error-line"]);
  });
});
