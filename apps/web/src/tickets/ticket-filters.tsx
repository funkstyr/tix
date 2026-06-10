import { type FormEvent, type JSX, useEffect, useRef } from "react";

import { Input } from "@tix/core-ui/input";
import { Select } from "@tix/core-ui/select";

import { type CatalogSearch, sortOptions } from "./list-search";

export type TicketFiltersProps = {
  search: CatalogSearch;
  onChange: (next: CatalogSearch) => void;
};

export function TicketFilters({ search, onChange }: TicketFiltersProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);

  function onSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const q = (inputRef.current?.value ?? "").trim();
    const patch: CatalogSearch = { ...search };
    delete patch.cursors;
    if (q.length > 0) patch.q = q;
    else delete patch.q;
    onChange(patch);
  }

  // Use a native event listener so the handler fires for imperatively-dispatched
  // change events in tests (React's synthetic onChange can suppress them on
  // uncontrolled checkboxes when checked is set directly on the element).
  useEffect(() => {
    const el = checkboxRef.current;
    if (el === null) return;

    function handleChange(): void {
      const checked = checkboxRef.current?.checked ?? false;
      const patch: CatalogSearch = { ...search };
      delete patch.cursors;
      if (checked) patch.availableOnly = true;
      else delete patch.availableOnly;
      onChange(patch);
    }

    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  });

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
        onValueChange={(sort) => {
          const patch: CatalogSearch = { ...search };
          delete patch.cursors;
          if (sort) patch.sort = sort as NonNullable<CatalogSearch["sort"]>;
          else delete patch.sort;
          onChange(patch);
        }}
        options={sortOptions}
      />

      <label className="flex items-center gap-2 text-sm">
        <input
          ref={checkboxRef}
          type="checkbox"
          defaultChecked={search.availableOnly ?? false}
        />
        Available only
      </label>
    </div>
  );
}
