import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TagReview } from "./TagReview";

const props = {
  label: "October 2026",
  total: 1,
  loaded: 1,
  loading: false,
  applying: false,
  applyDone: 0,
  applyTotal: 0,
  rows: [],
  txns: {},
  categories: [],
  suggester: "model" as const,
  result: null,
  onCancel: () => {},
  onApply: () => {},
  onUndo: () => {},
  onRemember: () => {},
  onRememberChoice: async () => ({ ok: true as const }),
  onDismissOffer: () => {},
};

test("draft summary replaces both mobile and desktop month subtitles", () => {
  const summary = "Claude Code proposed 1 tag · October tidy-up · nothing is saved until you press Apply";
  const html = renderToStaticMarkup(<TagReview {...props} summary={summary} />);
  expect(html.split(summary)).toHaveLength(3);
  expect(html).not.toContain("Ask Money found");
  expect(html).not.toContain("Suggesting tags for");
});

test("month review retains its subtitles when no summary is supplied", () => {
  const html = renderToStaticMarkup(<TagReview {...props} />);
  expect(html).toContain("Ask Money found 1 untagged transaction in October 2026");
  expect(html).toContain("except a payee default you tick Remember on");
});
