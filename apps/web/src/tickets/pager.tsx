import { type JSX } from "react";

import { Button } from "@tix/core-ui/button";

export type PagerProps = {
  page: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

export function Pager({ page, canPrev, canNext, onPrev, onNext }: PagerProps): JSX.Element {
  return (
    <nav className="mt-6 flex items-center justify-between" aria-label="Pagination">
      <Button variant="outline" size="sm" disabled={!canPrev} onClick={onPrev}>
        Previous
      </Button>

      <span className="text-muted-foreground text-sm">Page {page}</span>

      <Button variant="outline" size="sm" disabled={!canNext} onClick={onNext}>
        Next
      </Button>
    </nav>
  );
}
