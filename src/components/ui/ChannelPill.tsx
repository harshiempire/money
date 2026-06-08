import { cn } from "@/lib/cn";
import { Badge } from "./Badge";

const channelTones: Record<string, "neutral" | "violet" | "info" | "credit" | "warning"> = {
  upi: "violet",
  imps: "info",
  neft: "neutral",
  rtgs: "neutral",
  cheque: "warning",
  cash: "credit",
  card: "info",
  opening: "neutral",
  other: "neutral",
};

export function ChannelPill({ channel }: { channel: string }) {
  const tone = channelTones[channel] ?? "neutral";
  return <Badge tone={tone}>{channel}</Badge>;
}
