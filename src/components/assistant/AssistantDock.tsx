"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  assistantTurn,
  getAssistantBootstrap,
  loadAssistantTxns,
  prepareApplyToAll,
  prepareAssistantOp,
  type AssistantBootstrap,
  type TurnResult,
} from "@/app/assistant/actions";
import { setTransactionNeedsReview } from "@/app/transactions/actions";
import type { ChatMessage, HistoryTurn, OpDraft, TurnMessage, TxnCardData } from "@/lib/assistant/types";
import type { AiLimits } from "@/lib/ai/failure";
import { OpCard } from "./OpCard";
import { PickList, TxnCard } from "./TxnCard";
import { applyDraft, flashRow, showInTable, undoDraft } from "./ops";
import { chip, primaryButton } from "./ui";

type OpMessage = Extract<ChatMessage, { kind: "op" }>;
type Mode = "floating" | "docked";

const CHAT_KEY = "money.assistant.chat.v1";
const UI_KEY = "money.assistant.ui.v1";

const START_SUGGESTIONS = ["Show payments from August", "Find the ₹500 payment", "What did I receive yesterday?"];
const FOCUS_SUGGESTIONS = ["Add a note to it", "Split it half each", "Categorize it"];

const uid = () => crypto.randomUUID();

function thinkingText(message: string, resumed: boolean): string {
  const t = message.toLowerCase();
  if (resumed) return "Preparing…";
  if (/settle|sent me/.test(t)) return "Loading open balances…";
  if (/split|paid for/.test(t)) return "Preparing split…";
  if (/note/.test(t)) return "Preparing note…";
  if (/categor/.test(t)) return "Preparing category…";
  return "Searching transactions…";
}

function errorText(e: unknown, fallback: string): string {
  // Production builds replace server-action error messages with a generic one.
  if (e instanceof Error && e.message && !/server components render|digest/i.test(e.message)) return e.message;
  return fallback;
}

const formatReset = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );

function limitMeta(limits: AiLimits | null): string | undefined {
  if (limits?.usedPercent == null || limits.usedPercent < 80) return undefined;
  return `ChatGPT limit ${limits.usedPercent}% used${limits.resetsAt ? ` · resets ${formatReset(limits.resetsAt)}` : ""}`;
}

function toChat(m: TurnMessage, source: "ai" | "rules"): ChatMessage {
  if (m.kind === "op") return { kind: "op", id: uid(), draft: m.draft, status: "pending" };
  if (m.kind === "ai") return { ...m, id: uid(), source };
  return { ...m, id: uid() } as ChatMessage;
}

function toHistory(messages: ChatMessage[]): HistoryTurn[] {
  return messages.flatMap((m): HistoryTurn[] => {
    if (m.kind === "user") return [{ role: "user", text: m.text }];
    if (m.kind === "ai" && !m.retry) return [{ role: "assistant", text: m.text }];
    return [];
  });
}

/** A reload mid-save leaves the outcome unknown: say so rather than retrying blindly. */
function restoreMessage(m: ChatMessage): ChatMessage {
  if (m.kind !== "op") return m;
  if (m.status === "applying") {
    return { ...m, status: "pending", error: "The page reloaded while saving. Check the table before applying again." };
  }
  if (m.status === "undoing") {
    return { ...m, status: "applied", error: "The page reloaded while undoing. Check the table before trying again." };
  }
  return m;
}

function useIsDesktop() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

export function AssistantDock() {
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("floating");
  const [pos, setPos] = useState({ r: 24, b: 76 });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [txns, setTxns] = useState<Record<string, TxnCardData>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [used, setUsed] = useState<string[]>([]);
  const [boot, setBoot] = useState<AssistantBootstrap | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);

  const desktop = useIsDesktop();
  const docked = mode === "docked" && desktop;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(false);
  const inFlightOps = useRef(new Set<string>());
  const lastRequest = useRef<{ text: string; resumedAfterPick: boolean; focus: string | null } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; r: number; b: number } | null>(null);

  // ─── Persistence ───────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const ui = JSON.parse(localStorage.getItem(UI_KEY) ?? "null");
      if (ui) {
        setOpen(Boolean(ui.open));
        if (ui.mode === "docked" || ui.mode === "floating") setMode(ui.mode);
        if (typeof ui.pos?.r === "number" && typeof ui.pos?.b === "number") setPos(ui.pos);
      }
      const chat = JSON.parse(sessionStorage.getItem(CHAT_KEY) ?? "null");
      if (chat) {
        setMessages((chat.messages ?? []).map(restoreMessage));
        setTxns(chat.txns ?? {});
        setFocus(chat.focus ?? null);
        setUsed(chat.used ?? []);
      }
    } catch {
      /* corrupt storage — start fresh */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const chat = { messages: messages.filter((m) => m.kind !== "thinking"), txns, focus, used };
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(chat));
  }, [hydrated, messages, txns, focus, used]);

  useEffect(() => {
    if (hydrated) localStorage.setItem(UI_KEY, JSON.stringify({ open, mode, pos }));
  }, [hydrated, open, mode, pos]);

  // ─── Loading ───────────────────────────────────────────────────────────
  const refreshTxns = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return [];
    const fresh = await loadAssistantTxns({ ids });
    setTxns((t) => ({ ...t, ...Object.fromEntries(fresh.map((x) => [x.id, x])) }));
    return fresh;
  }, []);

  useEffect(() => {
    if (!open || !hydrated) return;
    if (!boot) getAssistantBootstrap().then(setBoot).catch(() => {});
    // Cards may be stale after navigating or editing in the table.
    refreshTxns(Object.keys(txns)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hydrated]);

  // ─── Keyboard, drag, scroll ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setPos({
        r: Math.min(window.innerWidth - 120, Math.max(8, d.r - (e.clientX - d.x))),
        b: Math.min(window.innerHeight - 80, Math.max(8, d.b - (e.clientY - d.y))),
      });
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const last = messages[messages.length - 1];
  useEffect(() => {
    if (!open) return;
    const go = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    requestAnimationFrame(go);
    const t = window.setTimeout(go, 80);
    return () => window.clearTimeout(t);
  }, [open, messages.length, last]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // ─── Messages ──────────────────────────────────────────────────────────
  const push = (...ms: ChatMessage[]) => setMessages((all) => [...all, ...ms]);
  const update = (id: string, patch: (m: ChatMessage) => ChatMessage) =>
    setMessages((all) => all.map((m) => (m.id === id ? patch(m) : m)));
  const updateOp = (id: string, patch: Partial<OpMessage>) =>
    update(id, (m) => (m.kind === "op" ? { ...m, ...patch } : m));

  const send = async (text: string, opts: { hidden?: boolean; resumedAfterPick?: boolean; focus?: string | null } = {}) => {
    const message = text.trim();
    if (!message || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const focusId = opts.focus !== undefined ? opts.focus : focus;
    lastRequest.current = { text: message, resumedAfterPick: Boolean(opts.resumedAfterPick), focus: focusId };
    const history = toHistory(messagesRef.current);
    const thinkingId = uid();
    push(
      ...(opts.hidden ? [] : [{ kind: "user" as const, id: uid(), text: message }]),
      { kind: "thinking", id: thinkingId, text: thinkingText(message, Boolean(opts.resumedAfterPick)) },
    );
    if (!opts.hidden) setInput("");

    let res: TurnResult | null = null;
    try {
      res = await assistantTurn({ message, history, focusTxnId: focusId, resumedAfterPick: opts.resumedAfterPick });
    } catch {
      res = null;
    }

    setMessages((all) => {
      const rest = all.filter((m) => m.id !== thinkingId);
      if (!res) {
        return [...rest, { kind: "ai", id: uid(), text: "That didn't go through. Nothing was changed.", retry: true }];
      }
      if (!res.ok) return [...rest, { kind: "ai", id: uid(), text: res.error }];
      const reader = res.reader;
      const added = res.messages.map((m) => toChat(m, reader));
      const meta = limitMeta(res.limits);
      if (meta && added[0]?.kind === "ai") added[0] = { ...added[0], meta };
      return [...rest, ...added];
    });
    if (res?.ok) {
      const fresh = res.txns;
      setTxns((t) => ({ ...t, ...Object.fromEntries(fresh.map((x) => [x.id, x])) }));
      setFocus(res.focusTxnId);
    }
    busyRef.current = false;
    setBusy(false);
  };

  const retry = () => {
    const r = lastRequest.current;
    if (r) void send(r.text, { hidden: true, resumedAfterPick: r.resumedAfterPick, focus: r.focus });
  };

  // ─── Pending cards ─────────────────────────────────────────────────────
  const apply = async (msg: OpMessage) => {
    if (msg.status !== "pending" || inFlightOps.current.has(msg.id)) return;
    inFlightOps.current.add(msg.id);
    updateOp(msg.id, { status: "applying", error: undefined });
    try {
      const out = await applyDraft(msg.draft, txns[msg.draft.txnId], boot?.categories ?? []);
      updateOp(msg.id, { status: "applied", undo: out.undo });
      push({
        kind: "ai",
        id: uid(),
        text: out.message,
        link: msg.draft.txnId,
        action: out.offerApplyToAll
          ? { kind: "cat_all", txnId: msg.draft.txnId, label: "Apply to every payment from this payee" }
          : undefined,
      });
      // A net settle can finish splits on other rows — refresh every card.
      await refreshTxns(Object.keys({ ...txns, [msg.draft.txnId]: true }));
      flashRow(msg.draft.txnId);
    } catch (e) {
      updateOp(msg.id, { status: "pending", error: errorText(e, "Couldn't save that. Check the table and try again.") });
    } finally {
      inFlightOps.current.delete(msg.id);
    }
  };

  const undo = async (msg: OpMessage) => {
    if (msg.status !== "applied" || !msg.undo || inFlightOps.current.has(msg.id)) return;
    inFlightOps.current.add(msg.id);
    updateOp(msg.id, { status: "undoing", error: undefined });
    try {
      const [fresh] = await loadAssistantTxns({ ids: [msg.draft.txnId] });
      const text = await undoDraft(msg.draft, msg.undo, fresh);
      updateOp(msg.id, { status: "undone" });
      push({ kind: "ai", id: uid(), text, link: msg.draft.txnId });
      await refreshTxns(Object.keys(txns));
      flashRow(msg.draft.txnId);
    } catch (e) {
      updateOp(msg.id, { status: "applied", error: errorText(e, "Couldn't undo that. Check the table.") });
    } finally {
      inFlightOps.current.delete(msg.id);
    }
  };

  /** "Apply to every payment from this payee" — opens a preview card; nothing is written yet. */
  const runCatAll = async (msgId: string, txnId: string) => {
    const setState = (state: "running" | "done" | undefined) =>
      update(msgId, (m) => (m.kind === "ai" && m.action ? { ...m, action: { ...m.action, state } } : m));
    setState("running");
    try {
      const res = await prepareApplyToAll({ txnId });
      setState("done");
      if (res.ok) push({ kind: "op", id: uid(), draft: res.draft, status: "pending" });
      else push({ kind: "ai", id: uid(), text: res.reason });
    } catch (e) {
      setState(undefined);
      push({ kind: "ai", id: uid(), text: errorText(e, "Couldn't check that. Try again.") });
    }
  };

  // ─── Transaction card buttons ──────────────────────────────────────────
  const withCard = async (fn: () => Promise<void>) => {
    if (cardBusy) return;
    setCardBusy(true);
    try {
      await fn();
    } catch (e) {
      push({ kind: "ai", id: uid(), text: errorText(e, "That didn't save. Try again.") });
    } finally {
      setCardBusy(false);
    }
  };

  const spawnOp = (kind: "split" | "note" | "net", t: TxnCardData) =>
    withCard(async () => {
      setFocus(t.id);
      const res = await prepareAssistantOp({ kind, txnId: t.id });
      if (!res.ok) {
        push({ kind: "ai", id: uid(), text: res.reason, link: t.id });
        return;
      }
      const intro: Record<OpDraft["op"], string> = {
        split: "Who is this split with? Fill in the card, then apply.",
        note: "Write the note, then apply.",
        net: "Review the lines, then save.",
        cat: "",
        cat_all: "",
      };
      push({ kind: "ai", id: uid(), text: intro[res.draft.op] }, { kind: "op", id: uid(), draft: res.draft, status: "pending" });
    });

  const cardHandlers = (t: TxnCardData) => ({
    // Preview first, like every other change: the dropdown opens a pending card.
    onCategory: (categoryId: string) => {
      if (categoryId === (t.categoryId ?? "")) return;
      setFocus(t.id);
      push({
        kind: "op",
        id: uid(),
        draft: { op: "cat", txnId: t.id, currentCategoryId: t.categoryId, categoryId },
        status: "pending",
      });
    },
    onReview: () =>
      withCard(async () => {
        await setTransactionNeedsReview({ transactionId: t.id, needsReview: !t.needsReview });
        await refreshTxns([t.id]);
      }),
    onSplit: () => (t.drCr === "credit" ? spawnOp("net", t) : t.split ? showInTable(t) : spawnOp("split", t)),
    onNet: () => (t.netEventId ? showInTable(t) : spawnOp("net", t)),
    onNote: () => spawnOp("note", t),
    onOpen: () => showInTable(t),
  });

  const pick = (msg: Extract<ChatMessage, { kind: "pick" }>, txnId: string) => {
    if (msg.picked || busyRef.current) return;
    update(msg.id, (m) => (m.kind === "pick" ? { ...m, picked: txnId } : m));
    setFocus(txnId);
    if (msg.then === "act" && msg.request) {
      void send(msg.request, { hidden: true, resumedAfterPick: true, focus: txnId });
    } else {
      push({ kind: "txn", id: uid(), txnId });
    }
  };

  const reset = () => {
    if (busyRef.current) return;
    setMessages([]);
    setTxns({});
    setFocus(null);
    setUsed([]);
    lastRequest.current = null;
  };

  // ─── Render ────────────────────────────────────────────────────────────
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const startDrag = (e: ReactMouseEvent) => {
    if (docked || !desktop) return;
    drag.current = { x: e.clientX, y: e.clientY, r: pos.r, b: pos.b };
  };

  const suggestions = (focus ? FOCUS_SUGGESTIONS : START_SUGGESTIONS).filter((s) => !used.includes(s)).slice(0, 3);
  const categories = boot?.categories ?? [];

  const aiBanner =
    boot && boot.aiState !== "ready"
      ? boot.aiState === "off"
        ? "AI isn't turned on for this account — search uses built-in rules."
        : boot.aiState === "not_migrated"
          ? "AI setup isn't finished: this database has no ai_connection table (run bun run db:migrate from this branch). Using built-in rules."
          : boot.aiState === "not_connected"
          ? "ChatGPT isn't connected (bun run connect-chatgpt) — search uses built-in rules."
          : "The ChatGPT sign-in expired — reconnect with bun run connect-chatgpt."
      : null;

  const panelClass = docked
    ? "sticky top-0 z-30 flex h-screen w-[400px] shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    : "fixed inset-x-2 bottom-20 z-50 flex h-[min(640px,calc(100vh-100px))] flex-col overflow-hidden rounded-[10px] border border-neutral-200 bg-white shadow-[0_18px_50px_rgba(0,0,0,.25)] md:inset-x-auto md:right-[var(--ai-r)] md:bottom-[var(--ai-b)] md:w-[400px] dark:border-[#333] dark:bg-neutral-900 dark:shadow-[0_18px_50px_rgba(0,0,0,.55)]";

  return (
    <>
      {open && (
        <section
          aria-label="Ask Money"
          className={`${panelClass} text-neutral-900 dark:text-neutral-100`}
          style={{ "--ai-r": `${pos.r}px`, "--ai-b": `${pos.b}px` } as React.CSSProperties}
        >
          <header
            onMouseDown={startDrag}
            className={`flex select-none items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2.5 dark:border-neutral-800 ${
              docked || !desktop ? "" : "cursor-grab active:cursor-grabbing"
            }`}
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-semibold">Ask Money</span>
              <span className="truncate font-mono text-[10px] text-neutral-500">
                {boot?.accountName ?? "BoB"} · changes need your confirmation
              </span>
            </div>
            <div className="flex items-center gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
              <button type="button" onClick={reset} disabled={busy} className={chip.neutral}>
                New
              </button>
              {desktop && (
                <button type="button" onClick={() => setMode(docked ? "floating" : "docked")} className={chip.neutral}>
                  {docked ? "Float" : "Dock"}
                </button>
              )}
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="px-1 text-sm text-neutral-500">
                ✕
              </button>
            </div>
          </header>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3.5">
            {aiBanner && <p className="text-[11px] text-amber-700 dark:text-amber-400">{aiBanner}</p>}
            {messages.length === 0 && (
              <div className="flex flex-col gap-1.5 px-1 pb-2 pt-6">
                <div className="text-sm font-semibold">Ask about your transactions</div>
                <div className="text-xs text-neutral-600 dark:text-neutral-400">
                  Find payments, split them, add notes or categorize. Anything that changes data shows up as a pending card
                  first — edit it, then apply.
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className="flex animate-ai-in flex-col gap-1.5">
                {m.kind === "user" && (
                  <div className="max-w-[85%] self-end rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[13px] dark:bg-neutral-800">
                    {m.text}
                  </div>
                )}
                {m.kind === "thinking" && (
                  <div className="animate-ai-pulse text-xs text-neutral-500 dark:text-neutral-400">{m.text}</div>
                )}
                {m.kind === "ai" && (
                  <>
                    {m.notice && <div className="text-[11px] text-amber-700 dark:text-amber-400">{m.notice}</div>}
                    {m.trace && m.trace.length > 0 && (
                      <div className="flex flex-col gap-px font-mono text-[10.5px] text-neutral-500">
                        <div className="font-sans text-[10px] uppercase tracking-wide">Looked up in your Money data</div>
                        {m.trace.map((line, i) => (
                          <div key={i}>› {line}</div>
                        ))}
                      </div>
                    )}
                    <div className="text-[13px] text-neutral-800 dark:text-neutral-200">
                      {m.source && (
                        <span
                          className={`mr-1.5 rounded px-1 py-px align-[1px] text-[9px] font-medium uppercase tracking-wide ${
                            m.source === "ai"
                              ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"
                              : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                          }`}
                          title={m.source === "ai" ? "Written by ChatGPT from the lookups above" : "Built-in search, no AI"}
                        >
                          {m.source === "ai" ? "✦ AI" : "Built-in"}
                        </span>
                      )}
                      {m.text}
                    </div>
                    {m.link && txns[m.link] && (
                      <button
                        type="button"
                        onClick={() => showInTable(txns[m.link!])}
                        className="self-start text-xs text-neutral-500 underline underline-offset-[3px] hover:text-neutral-900 dark:hover:text-neutral-100"
                      >
                        Show in table →
                      </button>
                    )}
                    {m.action && m.action.state !== "done" && (
                      <button
                        type="button"
                        disabled={m.action.state === "running"}
                        onClick={() => runCatAll(m.id, m.action!.txnId)}
                        className={`self-start ${chip.neutral}`}
                      >
                        {m.action.state === "running" ? "Applying…" : m.action.label}
                      </button>
                    )}
                    {m.retry && (
                      <button type="button" onClick={retry} disabled={busy} className={`self-start ${chip.neutral}`}>
                        Try again
                      </button>
                    )}
                    {m.meta && <div className="text-[10.5px] text-neutral-500">{m.meta}</div>}
                  </>
                )}
                {m.kind === "txn" && txns[m.txnId] && (
                  <TxnCard
                    t={txns[m.txnId]}
                    reasons={m.reasons}
                    categories={categories}
                    busy={cardBusy}
                    {...cardHandlers(txns[m.txnId])}
                  />
                )}
                {m.kind === "pick" && (
                  <PickList
                    txns={m.txnIds.map((id) => txns[id]).filter((t): t is TxnCardData => Boolean(t))}
                    total={m.total ?? m.txnIds.length}
                    reasons={m.reasons}
                    picked={m.picked}
                    onPick={(id) => pick(m, id)}
                  />
                )}
                {m.kind === "op" && (
                  <OpCard
                    msg={m}
                    txn={txns[m.draft.txnId]}
                    categories={categories}
                    onChange={(draft) => updateOp(m.id, { draft, error: undefined })}
                    onApply={() => apply(m)}
                    onDiscard={() => updateOp(m.id, { status: "discarded", error: undefined })}
                    onUndo={() => undo(m)}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t border-neutral-200 px-3 pb-3 pt-2.5 dark:border-neutral-800">
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setUsed((u) => [...u, s]);
                      void send(s);
                    }}
                    className="rounded border border-neutral-300 px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form onSubmit={onSubmit} className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={1000}
                placeholder="Ask or tell Money to do something…"
                aria-label="Message"
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2.5 py-[7px] text-[13px] outline-none focus:border-neutral-500 dark:border-neutral-700"
              />
              <button type="submit" disabled={busy || !input.trim()} className={primaryButton}>
                Send
              </button>
            </form>
          </div>
        </section>
      )}

      {!(docked && open) && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="fixed bottom-20 right-4 z-40 flex h-10 items-center gap-2 rounded-[20px] border border-neutral-700 bg-neutral-900 px-3.5 text-[13px] font-medium text-white shadow-[0_6px_20px_rgba(0,0,0,.45)] md:bottom-6 md:right-6 dark:bg-neutral-100 dark:text-neutral-900"
        >
          <span>✦</span>
          <span>{open ? "Close" : "Ask AI"}</span>
          <span className="hidden font-mono text-[10px] text-neutral-400 md:inline dark:text-neutral-500">⌘J</span>
        </button>
      )}
    </>
  );
}
