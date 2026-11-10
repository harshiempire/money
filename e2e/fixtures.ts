import { test as base, expect, type Locator, type Page } from "@playwright/test";
import type { Sql } from "postgres";
import { connectE2e, seedDatabase } from "./seed";

export { expect };

export const test = base.extend<{ reseed: void }, { db: Sql }>({
  db: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires the pattern.
    async ({}, provide) => {
      const sql = connectE2e();
      await provide(sql);
      await sql.end();
    },
    { scope: "worker" },
  ],
  // Every test starts from the same data, so tests can run in any order.
  reseed: [
    async ({ db }, provide) => {
      await seedDatabase(db);
      await provide();
    },
    { auto: true },
  ],
});

/** The open native modal. Closed dialogs have no `open` attribute. */
export const openModal = (page: Page) => page.locator("dialog[open]");

/** A transaction row or card; both exist in the DOM and only one is displayed. */
export const txnRow = (page: Page, id: string) =>
  page.locator(`[id="txn-${id}"]:visible`);

export async function gotoTransactions(page: Page) {
  await page.goto("/transactions");
  await expect(page.getByRole("heading", { name: "Transactions", level: 1 })).toBeVisible();
}

/** Latest statement, so the October seed stays visible whatever today's date is. */
export async function gotoReimbursements(page: Page) {
  await page.goto("/reimbursements?statement=1");
  await expect(page.getByRole("heading", { name: "Reimbursements", level: 1 })).toBeVisible();
}

/** A click before React has hydrated does nothing, so retry until the modal is up. */
export async function openDialog(page: Page, trigger: Locator): Promise<Locator> {
  const dialog = openModal(page);
  await expect(async () => {
    if ((await dialog.count()) === 0) await trigger.click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return dialog;
}

export const rowButton = (row: Locator, name: string) =>
  row.getByRole("button", { name, exact: true });
