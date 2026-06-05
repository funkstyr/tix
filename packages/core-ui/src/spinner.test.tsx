import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("exposes an accessible status role and label", () => {
    const html = renderToStaticMarkup(<Spinner label="Loading tickets" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading tickets");
  });

  it("animates", () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain("animate-spin");
  });
});
