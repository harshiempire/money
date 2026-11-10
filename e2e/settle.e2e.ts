import { expect, gotoReimbursements, gotoTransactions, openDialog, openModal, rowButton, test, txnRow } from "./fixtures";

test("settle a credit against one share and read the receipt", async ({ page, db }) => {
  await gotoTransactions(page);
  const row = txnRow(page, "t-from-arjun");
  const dialog = await openDialog(page, rowButton(row, "Settle"));
  await expect(dialog.getByRole("heading", { name: "Mark as settlement" })).toBeVisible();

  const share = dialog.locator("div.rounded").filter({ hasText: "Arjun" }).filter({ hasText: "expected ₹2000.00" });
  await share.getByRole("button", { name: "All" }).click();
  await expect(share.getByPlaceholder("₹")).toHaveValue("2000.00");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog.getByRole("heading", { name: "Settlement saved" })).toBeVisible();
  await expect(dialog.getByText("₹2,000.00 applied · ₹0.00 still open")).toBeVisible();
  await expect(dialog.getByRole("definition").filter({ hasText: "₹2,000.00" })).toBeVisible();
  await expect(dialog.getByText("Not allocated yet")).toBeVisible();
  await expect(dialog.getByRole("definition").filter({ hasText: "₹1,500.00" })).toBeVisible();

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(openModal(page)).toHaveCount(0);
  await expect(rowButton(row, "₹1500.00 LEFT")).toBeVisible();
  const rows = await db`
    select split_participant_id, amount_paise::int as paise from settlement
    where inflow_transaction_id = 't-from-arjun'`;
  expect([...rows]).toEqual([{ split_participant_id: "sp-arjun-dinner", paise: 200000 }]);
});

test("cash settlement from reimbursements clears Kabir", async ({ page, db }) => {
  await gotoReimbursements(page);
  const kabir = page.getByRole("row", { name: /Kabir/ });
  const dialog = await openDialog(page, kabir.getByRole("button", { name: "Cash" }));
  await expect(dialog.getByRole("heading", { name: "Record cash settlement" })).toBeVisible();
  await expect(dialog.getByText("Kabir still owes ₹800.00")).toBeVisible();
  await expect(dialog.getByLabel("Amount")).toHaveValue("800.00");

  await dialog.getByLabel("Note").fill("Paid at the cinema");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(openModal(page)).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Kabir/ })).toHaveCount(0);
  await expect(page.getByText(/Kabir · ₹800.00 .* ₹800.00 cash/)).toBeVisible();
  const rows = await db`
    select amount_paise::int as paise, method, note from settlement
    where split_participant_id = 'sp-kabir-movie'`;
  expect([...rows]).toEqual([{ paise: 80000, method: "cash", note: "Paid at the cinema" }]);
});
