import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("renders its children", () => {
    const html = renderToStaticMarkup(<Badge>Reserved</Badge>);
    expect(html).toContain("Reserved");
  });

  it("renders a distinct success variant", () => {
    const html = renderToStaticMarkup(<Badge variant="success">Complete</Badge>);
    expect(html).toContain("bg-emerald-600");
  });
});
