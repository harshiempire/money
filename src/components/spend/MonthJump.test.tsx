import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthJump, MonthJumpDialog } from "./MonthJump";

test("closed month label is a button and does not render the dialog yet", () => {
  const html = renderToStaticMarkup(
    <MonthJump
      variant="label"
      label="November 2026 (in progress)"
      selectedMonthKey="2026-11"
      todayMonthKey="2026-11"
      basePath="/spend"
    />,
  );
  expect(html).toContain("November 2026 (in progress)");
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("July 2026");
  expect(html).not.toContain('role="dialog"');
});

test("jump dialog links July to that page's full month", () => {
  const html = renderToStaticMarkup(
    <MonthJumpDialog
      titleId="jump-title"
      year={2026}
      selectedMonthKey="2026-11"
      todayMonthKey="2026-11"
      basePath="/reimbursements"
      onYear={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain('href="/reimbursements?month=2026-07"');
  expect(html).toContain('aria-label="July 2026"');
  expect(html).toContain('aria-current="date"');
  expect(html).toContain("Jump to month");
});

test("statement ranges get the same jump chip", () => {
  const html = renderToStaticMarkup(
    <MonthJump
      variant="chip"
      label="Jump to month"
      anchorMonthKey="2026-10"
      todayMonthKey="2026-11"
      basePath="/timeline"
    />,
  );
  expect(html).toContain("Jump to month");
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).not.toContain("month=2026-07");
});
