import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";

export type WaterfallLabelStyle = "plain" | "accounting";

export type WaterfallRowKey =
  | "gross"
  | "friends"
  | "owed"
  | "credits"
  | "net";

export type WaterfallBarSegment = {
  leftPct: number;
  widthPct: number;
  variant: "neutral" | "inflow" | "owed-hatch" | "i-owe" | "spend";
};

export type WaterfallRowModel = {
  key: WaterfallRowKey;
  amountPaise: number;
  signedDisplay: boolean;
  bar: WaterfallBarSegment[];
  legend?: { paidBackPaise: number; waitingPaise: number };
  show: boolean;
};

export type WaterfallLayout = {
  scalePaise: number;
  yourShareAfterFriendsPaise: number;
  levelBeforeCreditsPaise: number;
  netSelfPaise: number;
  rows: WaterfallRowModel[];
};

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function buildWaterfallLayout({
  bridge,
  netSelfPaise,
  owedSelfPaise,
  reimbursement,
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  owedSelfPaise: number;
  reimbursement?: ReimbursementBridgeTotals;
}): WaterfallLayout | null {
  if (bridge.personalDebitGrossPaise <= 0 && bridge.netCreditPaise <= 0) {
    return null;
  }

  const scale = Math.max(bridge.personalDebitGrossPaise, 1);
  const yourShare = bridge.yourShareDebitPaise;
  const othersShare = bridge.othersSharePaise;
  const owed = owedSelfPaise;
  const credits = bridge.netCreditPaise;
  const net = netSelfPaise;

  const levelBeforeCredits = yourShare + owed;

  let paidBack = 0;
  let waiting = 0;
  if (othersShare > 0 && reimbursement) {
    paidBack = Math.min(reimbursement.settledReimbursePaise, othersShare);
    waiting = Math.min(
      reimbursement.outstandingReimbursePaise,
      othersShare - paidBack,
    );
  }

  const friendsBarWidth = pct(othersShare, scale);
  const friendsLeft = pct(yourShare, scale);
  const paidFrac =
    othersShare > 0 ? paidBack / othersShare : 0;
  const waitingFrac =
    othersShare > 0 ? waiting / othersShare : 0;

  const rows: WaterfallRowModel[] = [
    {
      key: "gross",
      amountPaise: bridge.personalDebitGrossPaise,
      signedDisplay: false,
      show: true,
      bar: [
        {
          leftPct: 0,
          widthPct: clampPct(100),
          variant: "neutral",
        },
      ],
    },
    {
      key: "friends",
      amountPaise: othersShare,
      signedDisplay: true,
      show: othersShare > 0,
      legend:
        othersShare > 0
          ? { paidBackPaise: paidBack, waitingPaise: waiting }
          : undefined,
      bar: [
        {
          leftPct: clampPct(friendsLeft),
          widthPct: clampPct(friendsBarWidth * paidFrac),
          variant: "inflow",
        },
        {
          leftPct: clampPct(friendsLeft + friendsBarWidth * paidFrac),
          widthPct: clampPct(friendsBarWidth * waitingFrac),
          variant: "owed-hatch",
        },
      ],
    },
    {
      key: "owed",
      amountPaise: owed,
      signedDisplay: true,
      show: owed > 0,
      bar: [
        {
          leftPct: clampPct(friendsLeft),
          widthPct: clampPct(pct(owed, scale)),
          variant: "i-owe",
        },
      ],
    },
    {
      key: "credits",
      amountPaise: credits,
      signedDisplay: true,
      show: credits > 0,
      bar: [
        {
          leftPct: clampPct(pct(net, scale)),
          widthPct: clampPct(pct(credits, scale)),
          variant: "inflow",
        },
      ],
    },
    {
      key: "net",
      amountPaise: net,
      signedDisplay: false,
      show: true,
      bar: [
        {
          leftPct: 0,
          widthPct: clampPct(pct(Math.abs(net), scale)),
          variant: net >= 0 ? "spend" : "inflow",
        },
      ],
    },
  ];

  return {
    scalePaise: scale,
    yourShareAfterFriendsPaise: yourShare,
    levelBeforeCreditsPaise: levelBeforeCredits,
    netSelfPaise: net,
    rows,
  };
}

export const WATERFALL_LABELS: Record<
  WaterfallLabelStyle,
  Record<
    WaterfallRowKey,
    { title: string; hint: string }
  >
> = {
  plain: {
    gross: {
      title: "Left your bank",
      hint: "All money out of Bank of Baroda",
    },
    friends: {
      title: "Was for friends",
      hint: "Their part of split bills you paid",
    },
    owed: {
      title: "A friend paid for you",
      hint: "Your share of a bill someone else paid",
    },
    credits: {
      title: "Came back to you",
      hint: "Refunds, cashback, income",
    },
    net: {
      title: "Really yours",
      hint: "The number at the top",
    },
  },
  accounting: {
    gross: {
      title: "Gross debits",
      hint: "All personal debits in the period",
    },
    friends: {
      title: "Paid for others",
      hint: "Others' share of split debits",
    },
    owed: {
      title: "Others paid (your share)",
      hint: "Your share paid by someone else",
    },
    credits: {
      title: "Refunds & income",
      hint: "Credits lowering net spend",
    },
    net: {
      title: "Net personal spend",
      hint: "Headline net for the period",
    },
  },
};
