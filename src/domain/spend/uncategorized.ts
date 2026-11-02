import { isNull, type AnyColumn } from "drizzle-orm";

// Matches the app's transaction attention filter and spend triage: all bank rows
// with no category, including credits and transfers. Owed expenses are separate.
export const UNCATEGORIZED_DESCRIPTION =
  "Bank transactions with category_id null, including credits and transfers; excludes owed_expense rows.";

export const isUncategorized = (row: { categoryId: string | null }): boolean => row.categoryId === null;
export const uncategorizedCondition = (categoryId: AnyColumn) => isNull(categoryId);
