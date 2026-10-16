# Spend report

Spend report shows what the signed-in user actually spent. With no imported statement the net personal spend is zero rupees and the page still explains the report.

## Sub-features

- `spend-open` opens the report from the sidebar.
- `spend-zero` shows a zero net personal spend.
- `spend-empty-copy` shows the report description for an account with no rows.

## How to get to it (user POV)

- Choose `Spend` in the sidebar.
- Open `/spend` while signed in.

## Driving it with verify-money

Preconditions:

- `.cursor/skills/verify-money/scripts/verify-money doctor` reports `"ok": true`.
- The browser is signed in as `verify-user@example.com`.
- The account has no imported statement. A non-zero total means this recipe's precondition failed.

- **Open the report.** Choose `Spend`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role link --name "Spend" --expect "Spend report"`. The heading reads `Spend report`.
- **Read the description.** The page shows `What you actually spent, what you fronted for others, and what came back.`
- **Read the total.** The net personal spend figure shows `0.00`.
- **Proof.** Capture the report. Run `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/spend/zero.aria.txt` and `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/spend/zero.png`. Both show `Spend report` and `0.00`.

## Gotchas

- The amount is `Intl` currency for 0 paise. On a typical en-IN Node it renders as `₹0.00`. Assert `0.00` when the rupee glyph or spacing differs.
- A zero report does not prove category breakdowns, daily bars, or a statement period. Those need an imported PDF, which this map does not include.
- The sidebar link is `Spend`. The heading is `Spend report`.
