import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders title, description, and action", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No tickets yet"
        description="Be the first to list one."
        action={<a href="/tickets/new">List a ticket</a>}
      />,
    );
    expect(html).toContain("No tickets yet");
    expect(html).toContain("Be the first to list one.");
    expect(html).toContain("List a ticket");
  });
});
