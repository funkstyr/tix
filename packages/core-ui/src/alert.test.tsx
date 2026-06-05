import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Alert } from "./alert";

describe("Alert", () => {
  it("renders message text inside an alert role", () => {
    const html = renderToStaticMarkup(<Alert>Sold out</Alert>);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sold out");
  });

  it("uses destructive styling by default", () => {
    const html = renderToStaticMarkup(<Alert>Boom</Alert>);
    expect(html).toContain("destructive");
  });
});
