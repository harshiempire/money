# Transactions

Transactions lists the signed-in account's rows. With no imported statement the list is empty, names the Bank of Baroda account, and search still returns that empty list.

## Sub-features

- `transactions-open` opens the list from the sidebar.
- `transactions-empty` shows the empty filter result and a zero count.
- `transactions-account` names the account created for this user.
- `transactions-search` applies a query that matches nothing and stays empty.

## How to get to it (user POV)

- Choose `Transactions` in the sidebar.
- Open `/transactions` while signed in.

## Driving it with verify-money

Preconditions:

- `.cursor/skills/verify-money/scripts/verify-money doctor` reports `"ok": true`.
- The browser is signed in as `verify-user@example.com`.
- The account has no imported statement. If rows are present, this empty-list recipe does not apply; report that instead of asserting the empty copy.

- **Open the list.** Choose `Transactions`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Transactions" --expect "No transactions match these filters."`. The heading reads `Transactions`.
- **Read the account.** The page shows `Account:` followed by `BoB SBA` and `(bob)`.
- **Read the count.** The page shows `Showing 0–0 of 0 transactions.`
- **Search.** Type a query and apply it. Run `.cursor/skills/verify-money/scripts/verify-money browser fill --role searchbox --name "Search" --value "verify-no-such-payee"` and `.cursor/skills/verify-money/scripts/verify-money browser click --role button --name "Apply" --expect "No transactions match these filters."`. The empty copy remains and the URL includes `q=verify-no-such-payee`.
- **Reset.** Choose `Reset`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Reset" --expect "No transactions match these filters."`. The search box is empty.
- **Proof.** Capture the empty list after reset. Run `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/transactions/empty.aria.txt` and `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/transactions/empty.png`. Both show `Transactions`, `BoB SBA`, and `No transactions match these filters.`

## Gotchas

- The empty copy is `No transactions match these filters.` even when the account has never had a row. Do not treat that sentence as proof that filters hid existing rows.
- The search control's accessible name is `Search`. Its placeholder is `Name, UPI ID, note or amount`.
- `Apply` is a submit button. Wait for the empty copy after the click; the URL should contain the query.
- Proving a populated table, a category change, or a split needs a statement import this map does not seed. Report that gap instead of calling the empty list a populated proof.
