export type SortOrder = "asc" | "desc";

export interface PaginationQuery {
  page: number;
  perPage: number;
  requested: boolean;
}

export interface PaginationMeta {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 250;
const ALLOWED_PER_PAGE = new Set([10, 50, 100, 250]);

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = (value as unknown[])[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export function parseListParam(value: unknown): Set<string> {
  const raw = firstQueryValue(value);
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function parsePaginationQuery(
  query: Record<string, unknown>,
  fallbackPerPage = DEFAULT_PER_PAGE,
): PaginationQuery {
  const pageRaw = Number(firstQueryValue(query.page));
  const perPageRaw = Number(firstQueryValue(query.perPage));
  const limitRaw = Number(firstQueryValue(query.limit));

  const requested =
    query.page !== undefined ||
    query.perPage !== undefined ||
    firstQueryValue(query.paged) === "true";

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  let perPage = fallbackPerPage;
  if (Number.isFinite(perPageRaw) && perPageRaw > 0) {
    perPage = Math.floor(perPageRaw);
  } else if (Number.isFinite(limitRaw) && limitRaw > 0) {
    perPage = Math.floor(limitRaw);
  }

  if (!ALLOWED_PER_PAGE.has(perPage)) {
    perPage = Math.min(Math.max(perPage, 1), MAX_PER_PAGE);
  }

  return {
    page,
    perPage,
    requested,
  };
}

export function paginateItems<T>(
  items: T[],
  pagination: PaginationQuery,
): { items: T[]; pagination: PaginationMeta } {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pagination.perPage));
  const page = Math.min(pagination.page, totalPages);
  const start = (page - 1) * pagination.perPage;
  const pageItems = items.slice(start, start + pagination.perPage);

  return {
    items: pageItems,
    pagination: {
      page,
      perPage: pagination.perPage,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

export function parseSortOrder(value: unknown): SortOrder {
  return firstQueryValue(value)?.toLowerCase() === "asc" ? "asc" : "desc";
}

export function sortByField<T>(
  items: T[],
  sort: string,
  order: SortOrder,
  valueForSort: (item: T, sort: string) => string | number | boolean | null | undefined,
): T[] {
  const direction = order === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const aValue = valueForSort(a, sort);
    const bValue = valueForSort(b, sort);
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") {
      return (aValue - bValue) * direction;
    }
    return (
      String(aValue).localeCompare(String(bValue), undefined, {
        numeric: true,
        sensitivity: "base",
      }) * direction
    );
  });
}
