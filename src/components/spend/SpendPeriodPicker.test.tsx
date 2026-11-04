import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SpendPeriodPicker } from "./SpendPeriodPicker";
import type { ResolvedSpendPeriod } from "@/lib/spend/period";

const november: ResolvedSpendPeriod = {
  period: {
    from: "2026-11-01",
    to: "2026-11-03",
    label: "November 2026 (in progress)",
  },
  mode: "month",
  monthKey: "2026-11",
  isPartial: true,
};

test("month arrows, presets, and the custom range stay, and the label can open the jump picker", () => {
  const html = renderToStaticMarkup(
    <SpendPeriodPicker resolved={november} sp={{}} basePath="/spend" />,
  );
  expect(html).toContain('href="/spend?month=2026-10"');
  expect(html).toContain('href="/spend?month=2026-12"');
  expect(html).toContain("November 2026 (in progress)");
  expect(html).toContain("Choose month, November 2026 (in progress)");
  expect(html).toContain("Month in progress");
  expect(html).toContain('href="/spend?preset=this_month"');
  expect(html).toContain('href="/spend?preset=last_30"');
  expect(html).toContain('href="/spend?preset=last_90"');
  expect(html).toContain('href="/spend?statement=1"');
  expect(html).toContain('name="from"');
  expect(html).toContain('name="to"');
  expect(html).toContain("Apply");
  expect(html).not.toContain("month=2026-07");
});

test("a statement period keeps its range and offers the same month jump", () => {
  const statement: ResolvedSpendPeriod = {
    period: {
      from: "2026-10-16",
      to: "2026-11-15",
      label: "2026-10-16 → 2026-11-15",
    },
    mode: "statement",
    isPartial: false,
  };
  const html = renderToStaticMarkup(
    <SpendPeriodPicker
      resolved={statement}
      sp={{ statement: "1" }}
      basePath="/timeline"
      statementPeriods={[
        { periodStart: "2026-10-16", periodEnd: "2026-11-15" },
        { periodStart: "2026-06-16", periodEnd: "2026-07-15" },
      ]}
    />,
  );
  expect(html).toContain("2026-10-16 → 2026-11-15");
  expect(html).toContain("Jump to month");
  expect(html).toContain("Past statement periods");
  expect(html).toContain("2026-06-16");
  expect(html).not.toContain('href="/timeline?month=2026-10"');
  expect(html).toContain('name="from"');
});
