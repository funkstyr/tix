import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogSearch } from "./list-search";
import { TicketFilters } from "./ticket-filters";

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

async function mount(search: CatalogSearch, onChange: (next: CatalogSearch) => void): Promise<void> {
  await act(async () => {
    root.render(<TicketFilters search={search} onChange={onChange} />);
  });
}

function input(selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (el === null) throw new Error(`No element for ${selector}`);

  return el;
}

describe("TicketFilters", () => {
  it("seeds the search box from the current query", async () => {
    await mount({ q: "drake" }, () => {});
    expect(input("input[name=q]").value).toBe("drake");
  });

  it("submits a trimmed query and resets the cursor stack", async () => {
    const onChange = vi.fn<(next: CatalogSearch) => void>();
    await mount({ cursors: ["c1"] }, onChange);

    const search = input("input[name=q]");
    await act(async () => {
      search.value = "  taylor ";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ q: "taylor", cursors: undefined });
  });

  it("toggles availableOnly and resets the cursor stack", async () => {
    const onChange = vi.fn<(next: CatalogSearch) => void>();
    await mount({ cursors: ["c1"] }, onChange);

    const checkbox = input("input[type=checkbox]");
    await act(async () => {
      checkbox.click();
    });

    expect(onChange).toHaveBeenCalledWith({ availableOnly: true, cursors: undefined });
  });
});
