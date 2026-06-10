import { type ChangeEvent, type FormEvent, type JSX, useRef } from "react";

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
  function commit(apply: (draft: CatalogSearch) => void): void {
    const draft: CatalogSearch = { ...search };
    delete draft.cursors;
    apply(draft);
    onChange(draft);
  }

  function onSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const q = (inputRef.current?.value ?? "").trim();
    commit((draft) => {
      if (q.length > 0) draft.q = q;
      else delete draft.q;
    });
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <form role="search" onSubmit={onSearchSubmit} className="flex-1 min-w-[12rem]">
        <Input
          ref={inputRef}
          name="q"
          defaultValue={search.q ?? ""}
          placeholder="Search tickets"
          aria-label="Search tickets"
        />
      </form>

      <Select
        aria-label="Sort tickets"
        value={search.sort ?? "newest"}
        onValueChange={(sort) =>
          commit((draft) => {
            draft.sort = sort as NonNullable<CatalogSearch["sort"]>;
          })
        }
        options={sortOptions}
      />

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          defaultChecked={search.availableOnly ?? false}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            commit((draft) => {
              if (event.currentTarget.checked) draft.availableOnly = true;
              else delete draft.availableOnly;
            })
          }
        />
        Available only
      </label>
    </div>
  );
}
