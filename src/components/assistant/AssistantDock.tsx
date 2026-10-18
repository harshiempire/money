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
import {
  openProposedTagDraft,
  resolveProposedTagDraft,
} from "@/app/assistant/proposed-tag-actions";
import type { ChatMessage, HistoryTurn, OpDraft, TurnMessage, TxnCardData } from "@/lib/assistant/types";
import type { AiLimits } from "@/lib/ai/failure";
import {
  applySuggestedTags,
  listContextNotesAction,
  rememberPayeeDefault,
  suggestTagChunk,
  undoSuggestedTags,
} from "@/app/assistant/tag-actions";
import { chunkApplyRows, type AppliedTag } from "@/lib/assistant/tag-apply";
import type { ContextNote, TagDraftRow } from "@/lib/assistant/tag-batch";
import { OpCard } from "./OpCard";
import { PickList, TxnCard } from "./TxnCard";
import { applyDraft, flashRow, showInTable, undoDraft } from "./ops";
import { ContextNotesButton } from "./ContextNotes";
import { TagMonthButton, TagReview, type TagReviewResult } from "./TagReview";
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
  if (/^tag\b|categor/.test(t)) return "Drafting tags…";
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
  if (m.kind === "tag_run") return { kind: "tag_run", id: uid(), year: m.year, month: m.month };
  if (m.kind === "ai") return { ...m, id: uid(), source };
  return { ...m, id: uid() } as ChatMessage;
}

function draftTxnId(draft: OpDraft): string | undefined {
  return "txnId" in draft ? draft.txnId : undefined;
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
  const [dismissingDraft, setDismissingDraft] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [batch, setBatch] = useState<{
    year: number;
    month: number;
    draftId?: string;
    notice?: string;
    summary?: string;
    label: string;
    total: number;
    loaded: number;
    rows: TagDraftRow[];
    txns: Record<string, TxnCardData>;
    phase: "loading" | "review" | "applying" | "done";
    applyDone: number;
    applyTotal: number;
    error?: string;
    suggester: "model" | "history" | "stub";
    result: TagReviewResult | null;
    undoRows: AppliedTag[];
  } | null>(null);

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
  const batchGen = useRef(0);
  const draftInFlight = useRef(false);

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
    getAssistantBootstrap().then(setBoot).catch(() => {});
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
      // Tell the model when the focus is a row the user picked, so "the one I selected" isn't searched for again.
      const focusPicked = !!focusId && messagesRef.current.some((m) => m.kind === "pick" && m.picked === focusId);
      res = await assistantTurn({ message, history, focusTxnId: focusId, resumedAfterPick: opts.resumedAfterPick, focusPicked });
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
      const txnId = draftTxnId(msg.draft);
      const out = await applyDraft(msg.draft, txnId ? txns[txnId] : undefined, boot?.categories ?? []);
      updateOp(msg.id, { status: "applied", undo: out.undo });
      push({
        kind: "ai",
        id: uid(),
        text: out.message,
        link: txnId,
        action: out.offerApplyToAll && txnId
          ? { kind: "cat_all", txnId, label: "Apply to every payment from this payee" }
          : undefined,
      });
      if (msg.draft.op === "context_note") {
        const notes = await listContextNotesAction();
        setBoot((b) => (b ? { ...b, contextNotes: notes } : b));
      }
      // A net settle can finish splits on other rows — refresh every card.
      if (txnId) {
        await refreshTxns(Object.keys({ ...txns, [txnId]: true }));
        flashRow(txnId);
      }
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
      const txnId = draftTxnId(msg.draft);
      const [fresh] = txnId ? await loadAssistantTxns({ ids: [txnId] }) : [];
      const text = await undoDraft(msg.draft, msg.undo, fresh);
      updateOp(msg.id, { status: "undone" });
      push({ kind: "ai", id: uid(), text, link: txnId });
      if (msg.undo.kind === "context_note") {
        const notes = await listContextNotesAction();
        setBoot((b) => (b ? { ...b, contextNotes: notes } : b));
      }
      await refreshTxns(Object.keys(txns));
      if (txnId) flashRow(txnId);
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
        context_note: "",
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

  const startBatch = async (year: number, month: number) => {
    const gen = ++batchGen.current;
    setOpen(true);
    setBatch({
      year,
      month,
      label: "",
      total: 0,
      loaded: 0,
      rows: [],
      txns: {},
      phase: "loading",
      applyDone: 0,
      applyTotal: 0,
      suggester: "history",
      result: null,
      undoRows: [],
    });
    let offset = 0;
    const rows: TagDraftRow[] = [];
    const batchTxns: Record<string, TxnCardData> = {};
    let label = "";
    let total = 0;
    let suggester: "model" | "history" | "stub" = "history";
    try {
      for (;;) {
        const res = await suggestTagChunk({ year, month, offset });
        if (gen !== batchGen.current) return;
        if (!res.ok) {
          setBatch((b) => (b ? { ...b, phase: "review", error: res.error } : b));
          return;
        }
        label = res.label;
        total = res.total;
        if (res.suggester !== "history") suggester = res.suggester;
        rows.push(...res.rows);
        for (const txn of res.txns) batchTxns[txn.id] = txn;
        const done = res.nextOffset === null;
        setBatch({
          year,
          month,
          label,
          total,
          loaded: rows.length,
          rows: [...rows],
          txns: { ...batchTxns },
          phase: done ? "review" : "loading",
          applyDone: 0,
          applyTotal: 0,
          suggester,
          result: null,
          undoRows: [],
        });
        if (res.nextOffset === null) return;
        offset = res.nextOffset;
      }
    } catch (e) {
      if (gen !== batchGen.current) return;
      setBatch((b) => (b ? { ...b, phase: "review", error: errorText(e, "Couldn't draft tags.") } : b));
    }
  };

  useEffect(() => {
    const pending = messages.find((m) => m.kind === "tag_run" && !m.started);
    if (!pending || pending.kind !== "tag_run") return;
    setMessages((ms) => ms.map((m) => (m.kind === "tag_run" && m.id === pending.id ? { ...m, started: true } : m)));
    void startBatch(pending.year, pending.month);
  }, [messages]);

  const refreshBoot = async () => {
    const next = await getAssistantBootstrap().catch(() => null);
    if (next) setBoot(next);
  };

  const openProposedBatch = async (draftId: string) => {
    if (draftInFlight.current || batch?.phase === "applying") return;
    const gen = ++batchGen.current;
    setDismissingDraft(null);
    setDraftError(null);
    setBatch({
      year: 0,
      month: 0,
      draftId,
      label: "proposed tags",
      total: 0,
      loaded: 0,
      rows: [],
      txns: {},
      phase: "loading",
      applyDone: 0,
      applyTotal: 0,
      suggester: "model",
      result: null,
      undoRows: [],
    });
    try {
      const res = await openProposedTagDraft({ draftId });
      if (gen !== batchGen.current) return;
      if (!res.ok) {
        setBatch((b) => (b ? { ...b, phase: "review", error: res.error } : b));
        return;
      }
      setBatch((b) =>
        b
          ? {
              ...b,
              draftId: res.draftId,
              label: res.label,
              total: res.total,
              summary: [
                `${res.sourceLabel} proposed ${res.total} tag${res.total === 1 ? "" : "s"}`,
                res.title,
                "nothing is saved until you press Apply",
              ]
                .filter(Boolean)
                .join(" · "),
              loaded: res.rows.length,
              rows: res.rows,
              txns: Object.fromEntries(res.txns.map((txn) => [txn.id, txn])),
              phase: "review",
              notice:
                res.changed > 0
                  ? res.changed === 1
                    ? "1 row changed since this was proposed and was left out."
                    : `${res.changed} rows changed since this was proposed and were left out.`
                  : undefined,
            }
          : b,
      );
    } catch (e) {
      if (gen !== batchGen.current) return;
      setBatch((b) =>
        b ? { ...b, phase: "review", error: errorText(e, "Couldn't open those proposed tags.") } : b,
      );
    }
  };

  const dismissProposedDraft = async (draftId: string) => {
    if (draftInFlight.current || dismissingDraft !== draftId) return;
    draftInFlight.current = true;
    setDraftBusy(true);
    setDraftError(null);
    try {
      const res = await resolveProposedTagDraft({ draftId, status: "dismissed" });
      if (!res.ok) {
        setDraftError(res.error);
        return;
      }
      setDismissingDraft(null);
      setBoot((b) =>
        b ? { ...b, proposedDrafts: b.proposedDrafts.filter((draft) => draft.id !== draftId) } : b,
      );
      await refreshBoot();
    } catch (e) {
      setDraftError(errorText(e, "Couldn't dismiss that draft. Try again."));
    } finally {
      draftInFlight.current = false;
      setDraftBusy(false);
    }
  };

  const applyBatch = async (selected: { transactionId: string; categoryId: string; expectedCurrentCategoryId: string | null }[]) => {
    if (!batch) return;
    const total = selected.length;
    setBatch({ ...batch, phase: "applying", applyDone: 0, applyTotal: total, error: undefined });
    const applied: AppliedTag[] = [];
    const failed: Array<{ transactionId: string; reason: string }> = [];
    let stopped = false;
    let cursor = 0;
    for (const slice of chunkApplyRows(selected)) {
      setBatch((b) => (b ? { ...b, phase: "applying", applyDone: cursor, applyTotal: total } : b));
      try {
        const res = await applySuggestedTags({ rows: slice });
        applied.push(...res.applied);
        failed.push(...res.failed);
      } catch (e) {
        stopped = true;
        const reason = errorText(e, "The save stopped before this row.");
        for (const row of selected.slice(cursor)) {
          if (applied.some((item) => item.transactionId === row.transactionId)) continue;
          if (failed.some((item) => item.transactionId === row.transactionId)) continue;
          failed.push({ transactionId: row.transactionId, reason });
        }
        break;
      }
      cursor += slice.length;
    }
    const names = [
      ...new Set(
        applied
          .map((row) => boot?.categories.find((c) => c.id === row.categoryId)?.name)
          .filter((name): name is string => Boolean(name)),
      ),
    ];
    const offers: TagReviewResult["offers"] = [];
    const byPayee = new Map<string, { categoryId: string; payee: string; existingCategoryId: string | null }>();
    for (const row of applied) {
      const draft = batch.rows.find((r) => r.txnId === row.transactionId);
      if (!draft?.counterpartyId) continue;
      const payee = batch.txns[row.transactionId]?.label ?? "this payee";
      const prev = byPayee.get(draft.counterpartyId);
      if (!prev) byPayee.set(draft.counterpartyId, { categoryId: row.categoryId, payee, existingCategoryId: draft.defaultCategoryId });
      else if (prev.categoryId !== row.categoryId) byPayee.delete(draft.counterpartyId);
    }
    for (const [counterpartyId, info] of byPayee) {
      const categoryName = boot?.categories.find((c) => c.id === info.categoryId)?.name;
      if (!categoryName || info.payee.includes("@") || /\d{5,}/.test(info.payee)) continue;
      if (info.existingCategoryId === info.categoryId) continue;
      const existingCategoryName = info.existingCategoryId
        ? boot?.categories.find((c) => c.id === info.existingCategoryId)?.name
        : undefined;
      offers.push({
        counterpartyId,
        categoryId: info.categoryId,
        categoryName,
        payee: info.payee,
        ...(existingCategoryName && info.existingCategoryId
          ? { existingCategoryId: info.existingCategoryId, existingCategoryName }
          : {}),
      });
    }
    await refreshBoot();
    setBatch({
      ...batch,
      phase: "done",
      applyDone: applied.length,
      applyTotal: total,
      result: {
        applied: applied.length,
        failed: failed.length,
        left: Math.max(0, batch.total - applied.length),
        names,
        offers: offers.slice(0, 2),
        savedIds: applied.map((row) => row.transactionId),
        failedRows: failed.map((row) => ({
          transactionId: row.transactionId,
          label: batch.txns[row.transactionId]?.label ?? "A payment",
          reason: row.reason,
        })),
        stopped,
      },
      undoRows: applied,
    });
    if (batch.draftId && applied.length > 0) {
      try {
        const res = await resolveProposedTagDraft({ draftId: batch.draftId, status: "applied" });
        if (!res.ok) {
          setBatch((b) =>
            b && b.draftId === batch.draftId
              ? { ...b, error: `Tags saved, but the draft couldn't be marked applied. ${res.error}` }
              : b,
          );
        }
      } catch (e) {
        setBatch((b) =>
          b && b.draftId === batch.draftId
            ? { ...b, error: errorText(e, "Tags saved, but the draft couldn't be marked applied.") }
            : b,
        );
      }
      await refreshBoot();
    }
  };

  const undoBatch = async () => {
    if (!batch?.result) return;
    let restored = 0;
    let failed = 0;
    let stopped = false;
    let cursor = 0;
    for (const slice of chunkApplyRows(batch.undoRows)) {
      try {
        const res = await undoSuggestedTags({ rows: slice });
        restored += res.restored;
        failed += res.failed;
      } catch {
        stopped = true;
        failed += batch.undoRows.length - cursor;
        break;
      }
      cursor += slice.length;
    }
    await refreshBoot();
    setBatch({
      ...batch,
      result: {
        ...batch.result,
        undone: true,
        undoNote: stopped
          ? `Put ${restored} back. The undo stopped, so ${failed} saved rows were left as tagged.`
          : failed > 0
            ? `Put ${restored} back. ${failed} had changed and were left alone.`
            : `Put ${restored} transaction${restored === 1 ? "" : "s"} back.`,
        offers: [],
      },
    });
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
  const proposedDrafts = [...(boot?.proposedDrafts ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
              <ContextNotesButton
                notes={boot?.contextNotes ?? []}
                onChange={(notes: ContextNote[]) => setBoot((b) => (b ? { ...b, contextNotes: notes } : b))}
              />
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
                    txn={"txnId" in m.draft ? txns[m.draft.txnId] : undefined}
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
            <div className="flex flex-wrap gap-1.5">
              <TagMonthButton
                months={boot?.untaggedMonths ?? []}
                disabled={busy || batch?.phase === "loading"}
                onTag={(year, month) => void startBatch(year, month)}
              />
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
            {proposedDrafts.length > 0 && (
              <div className="space-y-1">
                {proposedDrafts.slice(0, 3).map((draft) => (
                  <div key={draft.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <button
                      type="button"
                      disabled={busy || draftBusy || Boolean(batch)}
                      onClick={() => void openProposedBatch(draft.id)}
                      title={draft.title ?? undefined}
                      className={
                        "min-w-0 break-words text-left text-neutral-700 underline underline-offset-2 " +
                        "disabled:opacity-50 dark:text-neutral-300"
                      }
                    >
                      Review {draft.rowCount} proposed tag{draft.rowCount === 1 ? "" : "s"} ·{" "}
                      {draft.sourceLabel}
                    </button>
                    {dismissingDraft === draft.id ? (
                      <div className="flex w-full flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                        <span>Dismiss this draft? Transactions stay as they are.</span>
                        <button
                          type="button"
                          disabled={draftBusy}
                          onClick={() => void dismissProposedDraft(draft.id)}
                          className="text-red-600 underline disabled:opacity-50 dark:text-red-400"
                        >
                          Yes, dismiss
                        </button>
                        <button
                          type="button"
                          disabled={draftBusy}
                          onClick={() => setDismissingDraft(null)}
                          className="underline"
                        >
                          Keep draft
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={draftBusy || Boolean(batch)}
                        onClick={() => {
                          setDismissingDraft(draft.id);
                          setDraftError(null);
                        }}
                        className="text-[11px] text-neutral-500 underline disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                ))}
                {proposedDrafts.length > 3 && (
                  <p className="text-[11px] text-neutral-500">and {proposedDrafts.length - 3} more</p>
                )}
              </div>
            )}
            {draftError && (
              <p role="alert" className="text-[11px] text-red-600 dark:text-red-400">
                {draftError}
              </p>
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

      {batch && (
        <TagReview
          key={batch.draftId ?? `${batch.year}-${batch.month}`}
          label={batch.label}
          total={batch.total}
          loaded={batch.loaded}
          loading={batch.phase === "loading"}
          applying={batch.phase === "applying"}
          applyDone={batch.applyDone}
          applyTotal={batch.applyTotal}
          rows={batch.rows}
          txns={batch.txns}
          categories={boot?.categories ?? []}
          error={batch.error}
          notice={batch.notice}
          summary={batch.summary}
          suggester={batch.suggester}
          result={batch.result}
          onCancel={() => {
            batchGen.current += 1;
            setBatch(null);
          }}
          onApply={(rows) => void applyBatch(rows)}
          onUndo={() => void undoBatch()}
          onRememberChoice={async (offer) => {
            try {
              const res = await rememberPayeeDefault({
                counterpartyId: offer.counterpartyId,
                categoryId: offer.categoryId,
                confirmFromCategoryId: offer.existingCategoryId ?? null,
              });
              if (res.ok) {
                setBatch((b) =>
                  b
                    ? {
                        ...b,
                        error: undefined,
                        rows: b.rows.map((row) =>
                          row.counterpartyId === offer.counterpartyId ? { ...row, defaultCategoryId: offer.categoryId } : row,
                        ),
                      }
                    : b,
                );
                return res;
              }
              if (!("confirm" in res)) setBatch((b) => (b ? { ...b, error: res.error } : b));
              return res;
            } catch (e) {
              const error = errorText(e, "Couldn't update that default.");
              setBatch((b) => (b ? { ...b, error } : b));
              return { ok: false as const, error };
            }
          }}
          onRemember={(offer) => {
            void rememberPayeeDefault({
              counterpartyId: offer.counterpartyId,
              categoryId: offer.categoryId,
              confirmFromCategoryId: offer.existingCategoryId ?? null,
            })
              .then((res) => {
                if (res.ok) {
                  setBatch((b) =>
                    b?.result
                      ? { ...b, error: undefined, result: { ...b.result, offers: b.result.offers.filter((o) => o.counterpartyId !== offer.counterpartyId) } }
                      : b,
                  );
                  return;
                }
                if ("confirm" in res) {
                  setBatch((b) =>
                    b?.result
                      ? {
                          ...b,
                          result: {
                            ...b.result,
                            offers: b.result.offers.map((item) =>
                              item.counterpartyId === offer.counterpartyId
                                ? {
                                    ...item,
                                    existingCategoryId: res.existingCategoryId,
                                    existingCategoryName: res.existingCategoryName,
                                    categoryName: res.nextCategoryName,
                                  }
                                : item,
                            ),
                          },
                        }
                      : b,
                  );
                  return;
                }
                setBatch((b) => (b ? { ...b, error: res.error } : b));
              })
              .catch((e) => {
                setBatch((b) => (b ? { ...b, error: errorText(e, "Couldn't update that default.") } : b));
              });
          }}
          onDismissOffer={(counterpartyId) =>
            setBatch((b) =>
              b?.result ? { ...b, result: { ...b.result, offers: b.result.offers.filter((o) => o.counterpartyId !== counterpartyId) } } : b,
            )
          }
        />
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
