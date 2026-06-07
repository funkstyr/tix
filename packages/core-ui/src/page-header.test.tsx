import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the title as a heading", () => {
    const html = renderToStaticMarkup(<PageHeader title="Tickets" />);
    expect(html).toMatch(/<h1[^>]*>Tickets<\/h1>/);
  });

  it("renders an optional description and action", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Tickets" description="Browse listings" action={<button>New</button>} />,
    );
    expect(html).toContain("Browse listings");
    expect(html).toContain("New");
  });
});
