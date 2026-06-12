import { type ChangeEvent, type FormEvent, type JSX, useCallback, useRef } from "react";

import { Input } from "@tix/core-ui/input";
import { Select } from "@tix/core-ui/select";

import { type CatalogSearch, sortOptions } from "./list-search";

export type TicketFiltersProps = {
  search: CatalogSearch;
  onChange: (next: CatalogSearch) => void;
};

export function TicketFilters({ search, onChange }: TicketFiltersProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  // Every control change returns to page 1, so each commit starts from the
  // current search minus its cursor stack, then applies the changed field.
  // `delete` rather than `= undefined`: exactOptionalPropertyTypes forbids
  // undefined on these optional keys.
  const commit = useCallback(
    (apply: (draft: CatalogSearch) => void): void => {
      const draft: CatalogSearch = { ...search };
      delete draft.cursors;
      apply(draft);
      onChange(draft);
    },
    [search, onChange],
  );

  const onSearchSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const q = (inputRef.current?.value ?? "").trim();
      commit((draft) => {
        if (q.length > 0) draft.q = q;
        else delete draft.q;
      });
    },
    [commit],
  );

  const onSortChange = useCallback(
    (sort: string): void => {
      commit((draft) => {
        draft.sort = sort as NonNullable<CatalogSearch["sort"]>;
      });
    },
    [commit],
  );

  const onAvailableChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      commit((draft) => {
        if (event.currentTarget.checked) draft.availableOnly = true;
        else delete draft.availableOnly;
      });
    },
    [commit],
  );

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <search className="min-w-[12rem] flex-1">
        <form onSubmit={onSearchSubmit}>
          <Input
            ref={inputRef}
            name="q"
            defaultValue={search.q ?? ""}
            placeholder="Search tickets"
            aria-label="Search tickets"
          />
        </form>
      </search>

      <Select
        aria-label="Sort tickets"
        value={search.sort ?? "newest"}
        onValueChange={onSortChange}
        options={sortOptions}
      />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Available only"
          defaultChecked={search.availableOnly ?? false}
          onChange={onAvailableChange}
        />
        Available only
      </label>
    </div>
  );
}
