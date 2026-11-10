import { expect, test as setup } from "@playwright/test";
import { AUTH_FILE, connectE2e, E2E_EMAIL, E2E_PASSWORD, seedDatabase } from "./seed";

setup("log in through the real form", async ({ page }) => {
  const sql = connectE2e();
  await seedDatabase(sql);
  await sql.end();

  await page.goto("/login");
  await page.getByLabel("Email").fill(E2E_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  await page.context().storageState({ path: AUTH_FILE });
});
