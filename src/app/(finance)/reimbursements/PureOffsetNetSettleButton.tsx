"use client";

import { NetSettleButton } from "../transactions/NetSettleDialog";
import type { CategoryOption } from "../transactions/RowActions";
import type {
  PayableOption,
  ReceivableOption,
} from "@/lib/net-events/load-net-settle-data";

export function PureOffsetNetSettleButton({
  receivables,
  payables,
  categories,
  knownPersonNames,
}: {
  receivables: ReceivableOption[];
  payables: PayableOption[];
  categories: CategoryOption[];
  knownPersonNames: string[];
}) {
  const today = new Date().toISOString().slice(0, 10);

  return (
    <NetSettleButton
      eventDate={today}
      receivables={receivables}
      payables={payables}
      categories={categories}
      knownPersonNames={knownPersonNames}
    />
  );
}
