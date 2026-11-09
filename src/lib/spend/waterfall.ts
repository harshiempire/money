import type { SplitBridgeTotals } from "@/domain/spend/net";

export function spendWaterfallRows(
  bridge: SplitBridgeTotals,
  owedSelfPaise: number,
  netSelfPaise: number,
) {
  const share = bridge.personalDebitGrossPaise - bridge.othersSharePaise;
  return [
    {
      key: "gross",
      label: "Left your bank",
      description: "Money out, excluding transfers and settlement payments",
      from: 0,
      to: bridge.personalDebitGrossPaise,
      delta: bridge.personalDebitGrossPaise,
      tone: "neutral",
    },
    {
      key: "others",
      label: "Was for friends",
      description: "Their share of your split bills",
      from: bridge.personalDebitGrossPaise,
      to: share,
      delta: -bridge.othersSharePaise,
      tone: "inflow",
    },
    {
      key: "owed",
      label: "A friend paid for you",
      description: "Your part of bills someone else paid",
      from: share,
      to: share + owedSelfPaise,
      delta: owedSelfPaise,
      tone: "i-owe",
    },
    {
      key: "credits",
      label: "Came back to you",
      description: "Refunds, cashback, income — after linked paybacks",
      from: share + owedSelfPaise,
      to: share + owedSelfPaise - bridge.netCreditPaise,
      delta: -bridge.netCreditPaise,
      tone: "inflow",
    },
    {
      key: "net",
      label: "Really yours",
      description:
        netSelfPaise < 0
          ? "More came in than you spent"
          : "Your net personal spend",
      from: 0,
      to: netSelfPaise,
      delta: netSelfPaise,
      tone: netSelfPaise < 0 ? "inflow" : "spend",
    },
  ];
}
