import type { Channel } from "../canonical";

export type CounterpartyKind =
  | "upi_handle"
  | "imps_payee"
  | "neft_payee"
  | "merchant"
  | "self";

export interface CounterpartyExtraction {
  kind: CounterpartyKind;
  key: string;
  displayName: string;
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|\s)\w/g, (m) => m.toUpperCase())
    .trim();

export const extractCounterparty = (
  rawDescription: string,
  channel: Channel,
): CounterpartyExtraction | null => {
  if (channel === "upi") {
    const m = rawDescription.match(
      /^UPI\/\d+\/[\d:]+\/(?:UPI|UDIR)\/([^\s/]+)/i,
    );
    if (m) {
      const handle = m[1].replace(/\s+/g, "").toLowerCase();
      return { kind: "upi_handle", key: handle, displayName: handle };
    }
  }

  if (channel === "imps") {
    const m = rawDescription.match(
      /^IMPS\/(?:P2A|P2P|P2M)\/\d+\/([^/]+?)(?:\/.*)?$/,
    );
    if (m) {
      const name = m[1].trim();
      return {
        kind: "imps_payee",
        key: name.toUpperCase(),
        displayName: titleCase(name),
      };
    }
  }

  if (channel === "neft") {
    const m = rawDescription.match(/^NEFT-[A-Z0-9]+-(.+?)(?:\s*-\s*)?$/);
    if (m) {
      const name = m[1].trim();
      return {
        kind: "neft_payee",
        key: name.toUpperCase(),
        displayName: titleCase(name),
      };
    }
  }

  return null;
};
