import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_MONTH_YEAR, MIN_MONTH_YEAR } from "@/lib/spend/month-jump";
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

test("year controls stop at the supported range", () => {
  const oldest = renderToStaticMarkup(
    <MonthJumpDialog
      titleId="jump-title"
      year={MIN_MONTH_YEAR}
      todayMonthKey="2026-11"
      basePath="/spend"
      onYear={() => {}}
      onClose={() => {}}
    />,
  );
  expect(oldest).toContain('aria-label="Previous year" disabled=""');
  expect(oldest).toContain('href="/spend?month=2000-01"');
  expect(oldest).not.toContain('aria-label="Next year" disabled=""');

  const newest = renderToStaticMarkup(
    <MonthJumpDialog
      titleId="jump-title"
      year={MAX_MONTH_YEAR}
      todayMonthKey="2026-11"
      basePath="/spend"
      onYear={() => {}}
      onClose={() => {}}
    />,
  );
  expect(newest).toContain('aria-label="Next year" disabled=""');
  expect(newest).toContain('href="/spend?month=2100-12"');
  expect(newest).not.toContain('aria-label="Previous year" disabled=""');
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
