import fusejs from "fuse.js";
import { createEffect, createMemo, createResource, createSignal, For, JSX, onMount, Show } from "solid-js";

interface AdditionalColumn<T> {
  name: string;
  content: (row: T) => JSX.Element;
  onClick?: () => void;
}

interface ColumnDef {
  name: string;
  key: Column;
  defaultSortAsc?: boolean;
}

type HeaderElement<T> = JSX.Element | ((rows: T[]) => JSX.Element);

interface TableProps<T extends { [key in Column]: any; }, Column extends keyof T> {
  inputRows: T[];
  headerElements?: HeaderElement<T>[];
  additionalColumns?: AdditionalColumn<T>[];
  columns: ColumnDef[];
  defaultSortColumn: Column;
  defaultSortAsc?: boolean;
  onRowClick?: (v: T) => any;
}

export default function Table<
  T extends { [key in Column]: any; },
  Column extends keyof T & string,
>(ps: TableProps<T, Column>) {
  const [sortBy, setSortBy] = createSignal<Column>(ps.defaultSortColumn);
  const [sortAsc, setSortAsc] = createSignal<boolean>(ps.defaultSortAsc ?? true);
  const [filterBy, setFilterBy] = createSignal<string>("");

  const colsByKey = createMemo(() => {
    let byKey: { [key: string]: ColumnDef } = {}
    ps.columns.forEach((c) => {
      byKey[c.key] = c;
    })
    return byKey
  });

  const updateSort = (column: Column) => {
    if (column == sortBy()) {
      setSortAsc(!sortAsc());
    } else {
      setSortBy(column as any);
      const colData = colsByKey()[column]
      if (colData) {
        setSortAsc(colData?.defaultSortAsc ?? true);
      } else {
        setSortAsc(true);
      }
    }
  };

  const fuseIndex = createMemo(() => {
    return new fusejs(ps.inputRows, {
      keys: ps.columns.map(col => col.key),
      threshold: 0.0,
    });
  });

  const rows = createMemo(() => {
    let sortedRows;
    if (filterBy()) {
      sortedRows = fuseIndex()
        .search(filterBy())
        .map(e => e.item);
    } else {
      sortedRows = [...ps.inputRows];
    }

    sortedRows.sort((a, b) => {
      const aValue = a[sortBy()];
      const bValue = b[sortBy()];
      const dir = sortAsc() ? 1 : -1;
      if (aValue < bValue) {
        return -1 * dir;
      } else if (aValue > bValue) {
        return 1 * dir;
      }
      return 0;
    });

    return sortedRows;
  });

  let inputRef: HTMLInputElement;
  onMount(() => {
    inputRef.focus();
  });

  return (
    <div class="flex flex-col h-full w-full">
      <div class="flex flex-row space-x-5 mt-2">
        <input
          class="m-1"
          placeholder="Filter"
          ref={inputRef!}
          oninput={e => setFilterBy(e.target.value ?? "")}
        />

        {ps.headerElements.map(element => element instanceof Function ? element(rows()) : element)}
      </div>

      <div class="flex-grow m-1 overflow-y-auto">
        <table class="w-full">
          <thead class="sticky top-0">
            <tr>
              {ps.columns.map(col => (
                <th
                  class="hover:cursor-pointer"
                  onclick={() => updateSort(col.key)}
                >
                  {col.name}
                </th>
              ))}

              {ps.additionalColumns
                ? ps.additionalColumns.map(col => <th onClick={col.onClick} classList={{ "hover:cursor-pointer": col.onClick }}>{col.name}</th>)
                : undefined}
            </tr>
          </thead>

          <tbody class="overflow-y-auto">
            <For each={rows()}>
              {row => {
                return (
                  <tr
                    class="hover:bg-slate-700"
                    onClick={ps.onRowClick ? e => ps.onRowClick(row) : undefined}
                  >
                    {ps.columns.map(col => <td>{row[col.key]}</td>)}

                    {ps.additionalColumns
                      ? ps.additionalColumns.map(col => <td>{col.content(row)}</td>)
                      : undefined}
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
