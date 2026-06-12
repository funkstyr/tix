import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Select } from "./select";

const options = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: low to high" },
] as const;

const noop = (): void => {};

describe("Select", () => {
  it("renders the selected option's label in the trigger", () => {
    const html = renderToStaticMarkup(
      <Select aria-label="Sort" value="price_asc" onValueChange={noop} options={options} />,
    );
    expect(html).toContain("Price: low to high");
  });

  it("exposes the aria-label on the trigger for assistive tech", () => {
    const html = renderToStaticMarkup(
      <Select aria-label="Sort tickets" value="newest" onValueChange={noop} options={options} />,
    );
    expect(html).toContain("Sort tickets");
  });
});
