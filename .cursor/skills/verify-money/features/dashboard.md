# Dashboard

The dashboard is the signed-in home page. For an account with no imported statement it shows net personal spend of zero, a transaction count of zero, and a prompt to import a Bank of Baroda statement.

## Sub-features

- `dashboard-open` opens the home page from the sidebar.
- `dashboard-empty` shows the empty-tenant card.
- `dashboard-import-link` offers the import page from that card.

## How to get to it (user POV)

- Choose `Dashboard` in the sidebar.
- Choose the `Money` wordmark.
- Open `/` while signed in.

## Driving it with verify-money

Preconditions:

- `.cursor/skills/verify-money/scripts/verify-money doctor` reports `"ok": true`.
- The browser is signed in as `verify-user@example.com` (see [Create account](./create-account.md)). If signed out, stop and report that. Do not invent transactions.

- **Open the dashboard.** Choose `Dashboard`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Dashboard" --expect "No transactions yet"`. The heading reads `Money` and the page shows `0 transactions`.
- **Read the empty card.** The section heading is `No transactions yet` and the card says `Import a Bank of Baroda statement to see your spend breakdown and categories here.`
- **Follow the import link.** Choose `Import statement →`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Import statement →" --expect "Import statement"`. The heading reads `Import statement` and the page says `No imports yet.`
- **Return.** Choose `Dashboard` again. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Dashboard" --expect "No transactions yet"`.
- **Proof.** Capture the dashboard, not the import page. Run `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/dashboard/home.aria.txt` and `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/dashboard/home.png`. Both show `Money`, `0 transactions`, and `No transactions yet`.

## Gotchas

- `Import statement →` includes the arrow in the accessible name. `Import statement` alone matches the page heading after navigation, not the card link.
- The import page proving `No imports yet.` does not prove that a PDF upload works. There is no statement fixture in this map.
- `0 transactions` on an empty account is not the same string as the transactions page empty copy.
