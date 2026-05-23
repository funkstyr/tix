import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Countdown } from "./countdown";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

async function advanceSeconds(seconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

describe("Countdown", () => {
  it("renders mm:ss from the time remaining until expiresAt", async () => {
    const expiresAt = new Date(Date.now() + 90 * 1000);

    await act(async () => {
      root.render(<Countdown expiresAt={expiresAt} />);
    });

    expect(container.textContent).toBe("01:30");
  });

  it("updates the display every second as time elapses", async () => {
    const expiresAt = new Date(Date.now() + 5 * 1000);

    await act(async () => {
      root.render(<Countdown expiresAt={expiresAt} />);
    });
    expect(container.textContent).toBe("00:05");

    await advanceSeconds(1);
    expect(container.textContent).toBe("00:04");

    await advanceSeconds(3);
    expect(container.textContent).toBe("00:01");
  });

  it("fires onExpire exactly once when the deadline is reached", async () => {
    const onExpire = vi.fn<() => void>();
    const expiresAt = new Date(Date.now() + 2 * 1000);

    await act(async () => {
      root.render(<Countdown expiresAt={expiresAt} onExpire={onExpire} />);
    });
    expect(onExpire).not.toHaveBeenCalled();

    await advanceSeconds(2);
    expect(container.textContent).toBe("00:00");
    expect(onExpire).toHaveBeenCalledTimes(1);

    await advanceSeconds(5);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("fires onExpire on mount when expiresAt is already in the past", async () => {
    const onExpire = vi.fn<() => void>();
    const expiresAt = new Date(Date.now() - 1000);

    await act(async () => {
      root.render(<Countdown expiresAt={expiresAt} onExpire={onExpire} />);
    });

    expect(container.textContent).toBe("00:00");
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
