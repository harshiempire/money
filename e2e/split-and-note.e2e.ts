import { expect, gotoTransactions, openDialog, openModal, rowButton, test, txnRow } from "./fixtures";

test("split a debit equally with a new participant", async ({ page, db }) => {
  await gotoTransactions(page);
  const row = txnRow(page, "t-groc");
  const dialog = await openDialog(page, rowButton(row, "Split"));
  await expect(dialog.getByRole("heading", { name: "Split transaction" })).toBeVisible();

  await dialog.getByPlaceholder("Name").first().fill("Neha");
  await dialog.getByRole("button", { name: "+ Add participant" }).click();
  await dialog.getByPlaceholder("Name").nth(1).fill("Priya");
  await dialog.getByRole("button", { name: "Equal split" }).click();
  await expect(dialog.getByPlaceholder("₹").first()).toHaveValue("781.66");
  await expect(dialog.getByPlaceholder("₹").nth(1)).toHaveValue("781.66");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(openModal(page)).toHaveCount(0);
  await expect(rowButton(row, "Split · pending")).toBeVisible();
  const shares = await db`
    select p.person_name, p.expected_amount_paise::int as paise, s.your_share_paise::int as mine
    from split_participant p join split s on s.id = p.split_id
    where s.transaction_id = 't-groc' order by p.person_name`;
  // Odd paise from an equal split go to the owner.
  expect([...shares]).toEqual([
    { person_name: "Neha", paise: 78166, mine: 78168 },
    { person_name: "Priya", paise: 78166, mine: 78168 },
  ]);
});

test("add a note and see it on the row", async ({ page, db }) => {
  await gotoTransactions(page);
  const row = txnRow(page, "t-uber");
  const dialog = await openDialog(page, rowButton(row, "Note…"));

  await dialog.getByPlaceholder("e.g. F1 TV subscription").fill("Cab to the airport");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(openModal(page)).toHaveCount(0);
  // The closed dialog keeps the same text in its textarea, so look only at the row's div.
  await expect(row.getByText("Cab to the airport").and(page.locator("div"))).toBeVisible();
  await expect(rowButton(row, "Note ✎")).toBeVisible();
  const [saved] = await db`select note from "transaction" where id = 't-uber'`;
  expect(saved?.note).toBe("Cab to the airport");
});
