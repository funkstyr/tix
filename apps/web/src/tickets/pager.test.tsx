import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Pager } from "./pager";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

function buttonByText(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (match === undefined) throw new Error(`No button containing "${text}"`);

  return match as HTMLButtonElement;
}

async function mount(props: Parameters<typeof Pager>[0]): Promise<void> {
  await act(async () => {
    root.render(<Pager {...props} />);
  });
}

describe("Pager", () => {
  it("shows the current page number", async () => {
    await mount({ page: 3, canPrev: true, canNext: true, onPrev: () => {}, onNext: () => {} });
    expect(container.textContent).toContain("Page 3");
  });

  it("disables Prev on the first page and Next on the last page", async () => {
    await mount({ page: 1, canPrev: false, canNext: false, onPrev: () => {}, onNext: () => {} });
    expect(buttonByText("Previous").disabled).toBe(true);
    expect(buttonByText("Next").disabled).toBe(true);
  });

  it("invokes the callbacks on click when enabled", async () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    await mount({ page: 2, canPrev: true, canNext: true, onPrev, onNext });

    await act(async () => {
      buttonByText("Previous").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttonByText("Next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
