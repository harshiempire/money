/**
 * Reads a rupee amount the way a person types it and returns exact paise.
 *
 * Pure string arithmetic — never goes through a float, so "0.29" is 29 paise
 * rather than 28.999…. Anything we can't read unambiguously returns null so
 * the caller asks instead of guessing.
 */
export function parseAmountToPaise(text: string): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/^(?:₹|rs\.?|inr|rupees?)\s*/, "")
    .replace(/\s*(?:₹|rs\.?|inr|rupees?|\/-)$/, "")
    .replace(/,/g, "")
    .trim();

  const m = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;

  const rupees = Number(m[1]);
  const paise = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}
