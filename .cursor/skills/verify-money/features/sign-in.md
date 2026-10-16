# Sign in

Sign in lets a person with an existing account open Money, and it rejects a wrong password without leaving the sign-in page.

## Sub-features

- `sign-in-open` shows the sign-in form.
- `sign-in-reject` shows an error for a wrong password and does not open the dashboard.
- `sign-in-accept` opens the dashboard for the right password.
- `sign-out` returns to the sign-in page.

## How to get to it (user POV)

- Open `/login`.
- On the create-account page, choose `Sign in`.
- After signing in, choose `Sign out` in the sidebar.

## Driving it with verify-money

Preconditions:

- `.cursor/skills/verify-money/scripts/verify-money doctor` reports `"ok": true`.
- `"user"` contains `verify-user@example.com` with password `verify-password-1` (the [Create account](./create-account.md) recipe). If that row is missing, stop and report the unmet precondition. Do not insert the row with SQL.
- The browser is signed out. If the dashboard is already visible, sign out before testing the reject path.

- **Sign out when needed.** If a sidebar is visible, choose `Sign out`. Run `.cursor/skills/verify-money/scripts/verify-money browser click --role button --name "Sign out" --expect "Sign in"`. The heading reads `Sign in`.
- **Open sign in.** Go to `/login`. Run `.cursor/skills/verify-money/scripts/verify-money browser open /login --expect "Sign in"`. The page offers `Create an account`.
- **Reject a wrong password.** Enter the email and a wrong password. Run `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Email" --value "verify-user@example.com"` and `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Password" --value "not-the-password"`, then `.cursor/skills/verify-money/scripts/verify-money browser click --role button --name "Sign in" --expect "Invalid email or password."`. The alert reads `Invalid email or password.` and the heading is still `Sign in`.
- **Sign in.** Replace the password and submit. Run `.cursor/skills/verify-money/scripts/verify-money browser fill --role textbox --name "Password" --value "verify-password-1"` and `.cursor/skills/verify-money/scripts/verify-money browser click --role button --name "Sign in" --expect "No transactions yet"`. The heading reads `Money`.
- **Proof.** Capture the signed-in dashboard. Run `.cursor/skills/verify-money/scripts/verify-money browser snapshot --path artifacts/sign-in/dashboard.aria.txt` and `.cursor/skills/verify-money/scripts/verify-money browser screenshot --path artifacts/sign-in/dashboard.png`. Both show `Money` and `No transactions yet`.

## Gotchas

- Wrong-password proof is the alert on `/login`, not a later successful sign-in.
- `Sign in` is both the heading and the submit button. The click target is the button.
- A session from Create account is already signed in. The reject path is meaningless until `Sign out` has run.
- Visiting `/` while signed out redirects to `/login`. That redirect is not a successful sign-in.
