"use client";

import { useState } from "react";
import { formatIsoDate, indiaCivilDate } from "@/lib/dates/india";
import { NetSettleButton } from "../transactions/NetSettleDialog";
import type { SettlementPayment } from "@/lib/ledger/rules/net-settlement-plan";
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
  bankPayments,
}: {
  receivables: ReceivableOption[];
  payables: PayableOption[];
  categories: CategoryOption[];
  knownPersonNames: string[];
  bankPayments: SettlementPayment[];
}) {
  const [today] = useState(() => formatIsoDate(indiaCivilDate()));

  return (
    <NetSettleButton
      eventDate={today}
      receivables={receivables}
      payables={payables}
      categories={categories}
      knownPersonNames={knownPersonNames}
      bankPayments={bankPayments}
    />
  );
}
