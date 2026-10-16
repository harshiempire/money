# Create account

Create account lets a new person register with an email and a password of at least 12 characters, then land on an empty Money dashboard that belongs to them.

## Sub-features

- `register-open` shows the create-account form.
- `register-save` creates the user, signs them in, and opens the dashboard.
- `register-persist` shows the same email in the `user` table.
- `register-empty` shows the empty-tenant dashboard, not another person's transactions.

## How to get to it (user POV)

- Open `/register`.
- On the sign-in page, choose `Create an account`.

## Driving it with verify-money

Preconditions:

- `.cursor/skills/verify-money/scripts/verify-money doctor` reports `"ok": true`.
- No row in `"user"` has email `verify-user@example.com`. A fresh launch satisfies this. If the email is already taken, stop and report the failure. Do not pick a different email to make the recipe pass.

- **Open the form.** Go to registration. Run `.cursor/skills/verify-money/scripts/verify-money browser open /register --expect "Create account"`. The heading reads `Create account` and the page offers `Sign in`.
- **Enter the account.** Fill the fields. Run `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Name (optional)" --value "Verify User"`, then `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Email" --value "verify-user@example.com"`, then `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Password" --value "verify-password-1"`, then `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Confirm password" --value "verify-password-1"`. The `Create account` button is visible.
- **Submit.** Choose `Create account`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role button --name "Create account" --expect "No transactions yet"`. The URL path is `/`, the heading reads `Money`, and a section heading reads `No transactions yet`.
- **Confirm the row.** Read the user back. Run `.cursor/skills/verify-money/scripts/verify-money db query "select email from \"user\" where email = 'verify-user@example.com'"`. The JSON array contains one object whose `email` is `verify-user@example.com`.
- **Proof.** Capture the empty dashboard this account landed on. Run `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/create-account/dashboard.aria.txt` and `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/create-account/dashboard.png`. Both show `Money`, `No transactions yet`, and `Import statement`.

## Gotchas

- A password shorter than 12 characters stays on `/register` and shows `Password must be at least 12 characters.`
- Mismatched confirmation shows `Passwords do not match.` and does not create a row.
- An email that already exists shows `An account with this email already exists.` That is a failed precondition, not a successful registration.
- The dashboard heading `Money` is also the sidebar link name. Assert the heading, not only the link.
- `No transactions yet` is the empty tenant. It is not proof that import, spend totals, or an existing statement work.
- Cleanup deletes the database. Keep the snapshot and screenshot under `/tmp/money-verify-evidence/<runId>/`.
