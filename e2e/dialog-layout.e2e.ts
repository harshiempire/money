import type { Locator, Page } from "@playwright/test";
import { expect, gotoReimbursements, gotoTransactions, openDialog, openModal, rowButton, test, txnRow } from "./fixtures";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function setTheme(page: Page, theme: Theme) {
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  const more = page.getByRole("button", { name: "More", exact: true });
  await expect(async () => {
    // On a phone the toggle lives in the More menu.
    if (!(await toggle.isVisible())) await more.click({ timeout: 2_000 });
    await expect(toggle).toBeVisible({ timeout: 1_000 });
    // dispatchEvent: under `next dev` the dev-tools badge sits over the sidebar toggle.
    if ((await html.getAttribute("data-theme")) !== theme) await toggle.dispatchEvent("click");
    await expect(html).toHaveAttribute("data-theme", theme, { timeout: 1_000 });
  }).toPass();
  const closeMenu = page.getByRole("button", { name: "Close menu" });
  if (await closeMenu.isVisible()) await closeMenu.click();
}

const brightness = (color: string) => {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return (r + g + b) / 3;
};

async function expectCentredAndThemed(dialog: Locator, page: Page, theme: Theme, label: string) {
  const viewport = page.viewportSize();
  const box = await dialog.boundingBox();
  if (!viewport || !box) throw new Error(`${label}: no geometry`);
  const right = viewport.width - box.x - box.width;
  const bottom = viewport.height - box.y - box.height;

  expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(0);
  expect(right, `${label} right edge`).toBeGreaterThanOrEqual(0);
  expect(bottom, `${label} bottom edge`).toBeGreaterThanOrEqual(0);
  expect(Math.abs(box.x - right), `${label} horizontal centring`).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - bottom), `${label} vertical centring`).toBeLessThanOrEqual(2);

  const style = await dialog.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      background: css.backgroundColor,
      text: css.color,
      sideways: el.scrollWidth - el.clientWidth,
    };
  });
  expect(style.sideways, `${label} sideways scroll`).toBeLessThanOrEqual(1);
  const [paper, ink] = [brightness(style.background), brightness(style.text)];
  if (theme === "dark") expect(paper, `${label} dark paper`).toBeLessThan(ink);
  else expect(paper, `${label} light paper`).toBeGreaterThan(ink);
}

async function checkAndClose(page: Page, dialog: Locator, theme: Theme, label: string) {
  await expectCentredAndThemed(dialog, page, theme, label);
  await page.keyboard.press("Escape");
  await expect(openModal(page)).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`every dialog is centred and fits: ${viewport.name}, ${theme}`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await gotoTransactions(page);
      await setTheme(page, theme);

      const check = async (label: string, trigger: Locator) => {
        await checkAndClose(page, await openDialog(page, trigger), theme, label);
      };

      await check("Split", rowButton(txnRow(page, "t-groc"), "Split"));
      await check("Split with people", rowButton(txnRow(page, "t-dinner"), "Split · pending"));
      await check("Settle", rowButton(txnRow(page, "t-from-arjun"), "Settle"));
      await check("Settle up, one person", rowButton(txnRow(page, "t-to-neha"), "Settle up"));
      await check("Settle up, several people", rowButton(txnRow(page, "t-from-arjun"), "Settle up"));
      await check("Note", rowButton(txnRow(page, "t-uber"), "Note…"));

      const advanced = await openDialog(page, rowButton(txnRow(page, "t-from-arjun"), "Settle up"));
      await advanced.getByRole("button", { name: "Enter individual bill amounts or add a bill" }).click();
      await expect(advanced.getByRole("heading", { name: "Net settle" })).toBeVisible();
      await checkAndClose(page, advanced, theme, "Net settle");

      await gotoReimbursements(page);
      await check("Settle up, no payment", page.getByRole("button", { name: "Settle up", exact: true }));
      await check("Cash", page.getByRole("row", { name: /Kabir/ }).getByRole("button", { name: "Cash" }));
      await check("Month picker", page.getByRole("button", { name: /Jump to month|Choose month/ }).first());

      await page.getByText("Tap for who owes what").first().click();
      await check("Forget it", page.getByRole("button", { name: "Forget it" }).first());
    });
  }
}
