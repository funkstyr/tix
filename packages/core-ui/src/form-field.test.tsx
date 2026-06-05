import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FormField } from "./form-field";

describe("FormField", () => {
  it("associates the label with the input via a shared id", () => {
    const html = renderToStaticMarkup(<FormField id="title" label="Title" />);
    expect(html).toContain('for="title"');
    expect(html).toContain('id="title"');
    expect(html).toContain("Title");
  });

  it("renders an error in an alert and marks the input invalid", () => {
    const html = renderToStaticMarkup(<FormField id="price" label="Price" error="Enter a valid price" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter a valid price");
    expect(html).toContain('aria-invalid="true"');
  });

  it("omits the error node when there is no error", () => {
    const html = renderToStaticMarkup(<FormField id="qty" label="Quantity" />);
    expect(html).not.toContain('role="alert"');
  });
});
