import { expect, gotoReimbursements, gotoTransactions, openDialog, openModal, rowButton, test, txnRow } from "./fixtures";

const inputForPerson = (dialog: ReturnType<typeof openModal>, person: string) =>
  dialog.locator("div.rounded").filter({ hasText: person }).getByPlaceholder("₹");

test("one person: the outgoing payment settles both sides with Neha", async ({ page, db }) => {
  await gotoTransactions(page);
  const row = txnRow(page, "t-to-neha");
  const dialog = await openDialog(page, rowButton(row, "Settle up"));

  await expect(dialog.getByRole("heading", { name: "Settle up with one person" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "You pay Neha ₹1,250.00" })).toBeVisible();
  await dialog.getByRole("button", { name: "Mark settled" }).click();

  await expect(dialog.getByRole("heading", { name: "Settlement saved" })).toBeVisible();
  await expect(dialog.getByText("The selected bills are settled.")).toBeVisible();

  // The save refreshes the page behind; the confirmation has to survive that.
  await expect(row.getByText("Net ✓")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Settlement saved" })).toBeVisible();

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(openModal(page)).toHaveCount(0);
  await expect(rowButton(row, "Net ✓")).toBeVisible();
  const [event] = await db`select outflow_transaction_id as out from net_event`;
  expect(event?.out).toBe("t-to-neha");
  const legs = await db`
    select coalesce(split_participant_id, owed_expense_id) as target, amount_paise::int as paise
    from settlement order by target`;
  expect([...legs]).toEqual([
    { target: "o-neha-dinner", paise: 185000 },
    { target: "sp-neha-uber", paise: 60000 },
  ]);
});

test("several people: Arjun's credit suggests Arjun and Priya", async ({ page, db }) => {
  await gotoTransactions(page);
  const row = txnRow(page, "t-from-arjun");
  const dialog = await openDialog(page, rowButton(row, "Settle up"));

  await expect(dialog.getByRole("heading", { name: "One payment, several people" })).toBeVisible();
  const arjun = dialog.getByRole("checkbox", { name: /Arjun/ });
  const priya = dialog.getByRole("checkbox", { name: /Priya/ });
  await expect(arjun).toBeChecked();
  await expect(priya).toBeChecked();
  await expect(dialog.getByText("Matches the bank payment")).toBeVisible();

  await priya.uncheck();
  await expect(dialog.getByRole("button", { name: "Confirm settlement for 1 person" })).toBeDisabled();
  await expect(dialog.getByText("₹1,500.00 less than the bank amount")).toBeVisible();

  await priya.check();
  await dialog.getByRole("button", { name: "Confirm settlement for 2 people" }).click();
  await expect(dialog.getByRole("heading", { name: "Settlement saved" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  await expect(openModal(page)).toHaveCount(0);
  await expect(rowButton(row, "Net ✓")).toBeVisible();
  const legs = await db`
    select split_participant_id as target, amount_paise::int as paise
    from settlement where inflow_transaction_id = 't-from-arjun' order by target`;
  expect([...legs]).toEqual([
    { target: "sp-arjun-dinner", paise: 200000 },
    { target: "sp-priya-dinner", paise: 150000 },
  ]);
});

test("bill-by-bill link keeps the transaction's payment and amounts", async ({ page }) => {
  await gotoTransactions(page);
  const dialog = await openDialog(page, rowButton(txnRow(page, "t-from-arjun"), "Settle up"));
  await expect(dialog.getByRole("checkbox", { name: /Priya/ })).toBeChecked();

  await dialog.getByRole("button", { name: "Enter individual bill amounts or add a bill" }).click();

  await expect(dialog.getByRole("heading", { name: "Net settle" })).toBeVisible();
  await expect(dialog.getByText("Inflow ₹3500.00")).toBeVisible();
  await expect(inputForPerson(dialog, "Arjun")).toHaveValue("2000.00");
  await expect(inputForPerson(dialog, "Priya")).toHaveValue("1500.00");
  await expect(dialog.getByText("✓ Balanced")).toBeVisible();
});

test("bill-by-bill link keeps a bank payment chosen on reimbursements", async ({ page }) => {
  await gotoReimbursements(page);
  const dialog = await openDialog(page, page.getByRole("button", { name: "Settle up", exact: true }));

  await dialog.getByLabel("Settle up with").selectOption("Neha");
  await expect(dialog.getByRole("heading", { name: "You pay Neha ₹1,250.00" })).toBeVisible();
  await dialog.getByLabel("Bank payment").selectOption({ index: 1 });

  await dialog.getByRole("button", { name: "Enter individual bill amounts or add a bill" }).click();

  await expect(dialog.getByRole("heading", { name: "Net settle" })).toBeVisible();
  await expect(dialog.getByText("Outflow ₹1250.00")).toBeVisible();
  await expect(inputForPerson(dialog, "Birthday dinner")).toHaveValue("1850.00");
  await expect(inputForPerson(dialog, "outstanding ₹600.00")).toHaveValue("600.00");
  await expect(dialog.getByText("✓ Balanced")).toBeVisible();
});
