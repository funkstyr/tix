import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldError } from "./field";

const SINGLE_ERROR = [{ message: "Enter a valid price" }];

const TWO_ERRORS = [{ message: "Too short" }, { message: "Must be a number" }];

const DUPLICATE_ERRORS = [{ message: "Required" }, { message: "Required" }];

const NO_ERRORS: { message?: string }[] = [];

const IGNORED_ERRORS = [{ message: "ignored" }];

describe("FieldError", () => {
  it("renders a single error as plain text in an alert", () => {
    const html = renderToStaticMarkup(<FieldError errors={SINGLE_ERROR} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter a valid price");
    expect(html).not.toContain("<li");
  });

  it("renders multiple distinct errors as a list", () => {
    const html = renderToStaticMarkup(<FieldError errors={TWO_ERRORS} />);
    expect(html).toContain("<ul");
    expect(html).toContain("Too short");
    expect(html).toContain("Must be a number");
  });

  it("dedupes errors sharing the same message", () => {
    const html = renderToStaticMarkup(<FieldError errors={DUPLICATE_ERRORS} />);
    expect(html).not.toContain("<ul");
    expect(html.match(/Required/g)).toHaveLength(1);
  });

  it("renders nothing when there are no errors", () => {
    expect(renderToStaticMarkup(<FieldError errors={NO_ERRORS} />)).toBe("");
    expect(renderToStaticMarkup(<FieldError />)).toBe("");
  });

  it("prefers explicit children over the errors prop", () => {
    const html = renderToStaticMarkup(
      <FieldError errors={IGNORED_ERRORS}>Custom message</FieldError>,
    );
    expect(html).toContain("Custom message");
    expect(html).not.toContain("ignored");
  });
});
