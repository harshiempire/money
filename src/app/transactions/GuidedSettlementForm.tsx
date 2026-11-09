"use client";

import { useId, useMemo, useRef, useState } from "react";
import { callAction, type ActionResult } from "@/lib/action/result";
import { formatDate, formatPaise } from "@/lib/format";
import type {
  PayableOption,
  ReceivableOption,
} from "@/lib/net-events/load-net-settle-data";
import type { NetEventLeg } from "@/lib/net-events/legs";
import { personBalanceKey } from "@/lib/ledger/rules/balances";
import {
  guidedSettlementLegs,
  personSettlementSelection,
  selectionTotals,
  settlementFix,
  settlementGroups,
  suggestSettlement,
  type SettlementGroup,
  type SettlementPayment,
  type SettlementSelection,
} from "@/lib/ledger/rules/net-settlement-plan";

export interface GuidedSettlementRequest {
  eventDate: string;
  inflowTransactionId?: string;
  outflowTransactionId?: string;
  legs: NetEventLeg[];
}

export function GuidedSettlementForm({
  eventDate,
  receivables,
  payables,
  payment,
  bankPayments = [],
  defaultPerson = "",
  onSave,
  onClose,
  onBusyChange,
}: {
  eventDate: string;
  receivables: ReceivableOption[];
  payables: PayableOption[];
  payment?: SettlementPayment;
  bankPayments?: SettlementPayment[];
  defaultPerson?: string;
  onSave: (
    request: GuidedSettlementRequest,
  ) => Promise<ActionResult<{ netEventId: string }>>;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const methodName = useId();
  const groups = useMemo(
    () => settlementGroups(receivables, payables),
    [receivables, payables],
  );
  const names = [
    ...new Map(
      groups.map((group) => [group.personKey, group.personName]),
    ).values(),
  ];
  const knownPeople = groups
    .filter((group) => group.personKey.startsWith("id:"))
    .map((group) => ({ id: group.personKey.slice(3), name: group.personName }));
  const personKey = (name: string) =>
    personBalanceKey(undefined, name, knownPeople);
  const preferred =
    names.find((name) => personKey(name) === personKey(defaultPerson)) ?? "";
  const preferredTotal = selectionTotals(
    groups,
    personSettlementSelection(groups, preferred, "bank"),
  );
  const signedBank = (source: SettlementPayment) =>
    source.direction === "credit" ? source.amountPaise : -source.amountPaise;
  const [view, setView] = useState<"person" | "group">(() =>
    payment && (!preferred || preferredTotal.net !== signedBank(payment))
      ? "group"
      : "person",
  );
  const [person, setPerson] = useState(preferred);
  const [method, setMethod] = useState<"bank" | "cash" | "offset">("bank");
  const [bankId, setBankId] = useState("");
  const [selection, setSelection] = useState<SettlementSelection>(() =>
    payment
      ? suggestSettlement(groups, signedBank(payment), defaultPerson)
      : {},
  );
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() =>
    Object.keys(selection),
  );
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [saved, setSaved] = useState<{
    remaining: number;
    person: string;
    partial: boolean;
  } | null>(null);

  const personFull = personSettlementSelection(groups, person, "bank");
  const personTotals = selectionTotals(groups, personFull);
  const matchingPayments = bankPayments.filter(
    (source) => signedBank(source) === personTotals.net,
  );
  const namedMatches = matchingPayments.filter(
    (source) =>
      source.personName && personKey(source.personName) === personKey(person),
  );
  const personBank =
    payment ??
    matchingPayments.find((source) => source.id === bankId) ??
    (namedMatches.length === 1 ? namedMatches[0] : undefined);
  const groupBank =
    payment ?? bankPayments.find((source) => source.id === bankId);
  const activePayment =
    view === "person"
      ? method === "bank"
        ? personBank
        : undefined
      : groupBank;
  const activeMethod =
    view === "person" ? method : activePayment ? "bank" : "offset";
  const activeSelection =
    view === "person"
      ? personSettlementSelection(groups, person, method)
      : selection;
  const totals = selectionTotals(groups, activeSelection);
  const expectedNet = activePayment ? signedBank(activePayment) : 0;
  const gap = totals.net - expectedNet;
  const anySelected = Object.values(activeSelection).some((value) => value > 0);
  const balanced = activeMethod === "cash" || gap === 0;
  const canSave =
    anySelected && balanced && (activeMethod !== "bank" || !!activePayment);
  const selectedGroups = groups.filter(
    (group) => (activeSelection[group.key] ?? 0) > 0,
  );
  const selectedPeople = new Set(selectedGroups.map((group) => group.personKey))
    .size;
  const offset = Math.min(personTotals.receivable, personTotals.payable);
  const fix = settlementFix(groups, selection, expectedNet);
  const visibleKeySet = new Set(visibleKeys);
  const visible = groups.filter(
    (group) => visibleKeySet.has(group.key) || (selection[group.key] ?? 0) > 0,
  );
  const available = groups.filter(
    (group) => !visibleKeySet.has(group.key) && !(selection[group.key] > 0),
  );
  const clearError = () => setError(null);

  function openGroup() {
    const source = method === "bank" ? personBank : undefined;
    setBankId(source?.id ?? "");
    const initial =
      method === "offset"
        ? personSettlementSelection(groups, person, "offset")
        : personFull;
    setSelection(initial);
    setVisibleKeys(Object.keys(initial));
    setView("group");
    setAdding(true);
    clearError();
  }

  async function submit() {
    if (saving.current || !canSave || refreshRequired) return;
    const plan = guidedSettlementLegs(
      groups,
      activeSelection,
      activeMethod,
      activePayment,
    );
    if (!plan.ok) {
      setError(plan.message);
      return;
    }
    const legs = plan.legs;
    saving.current = true;
    setPending(true);
    onBusyChange(true);
    clearError();
    try {
      const result = await callAction(() =>
        onSave({
          eventDate: activePayment?.date ?? eventDate,
          ...(activePayment?.direction === "credit"
            ? { inflowTransactionId: activePayment.id }
            : {}),
          ...(activePayment?.direction === "debit"
            ? { outflowTransactionId: activePayment.id }
            : {}),
          legs,
        }),
      );
      if (result.ok)
        setSaved({
          remaining: view === "person" ? personTotals.net - totals.net : 0,
          person,
          partial: selectedGroups.some(
            (group) => activeSelection[group.key] < group.outstandingPaise,
          ),
        });
      else {
        setError(result.message);
        // A lost reply may follow a committed save. Never blindly retry it.
        setRefreshRequired(
          ["INTERNAL", "UNAVAILABLE", "CONFLICT"].includes(result.code),
        );
      }
    } finally {
      saving.current = false;
      setPending(false);
      onBusyChange(false);
    }
  }

  if (saved)
    return (
      <div className="guided-settlement gs-confirmation" role="status">
        <h2>Settlement saved</h2>
        <p>
          {saved.remaining === 0
            ? saved.partial
              ? "The selected amounts are recorded. Partly settled and unselected balances stay open."
              : "The selected bills are settled."
            : `${formatPaise(Math.abs(saved.remaining))} ${saved.remaining > 0 ? `is still owed to you by ${saved.person}` : `is still owed to ${saved.person}`} from these bills.`}
        </p>
        <p>No money is sent from this screen.</p>
        <button type="button" className="gs-primary" onClick={onClose}>
          Done
        </button>
      </div>
    );

  return (
    <div className="guided-settlement">
      <header className="gs-title">
        <h2>
          {view === "person"
            ? "Settle up with one person"
            : "One payment, several people"}
        </h2>
        <button
          type="button"
          className="gs-text-button"
          onClick={onClose}
          disabled={pending}
        >
          Close
        </button>
      </header>
      <fieldset disabled={pending || refreshRequired} className="gs-fields">
        {view === "person" ? (
          <>
            <label className="gs-person-picker">
              Settle up with
              <select
                value={person}
                onChange={(event) => {
                  setPerson(event.target.value);
                  setBankId("");
                  clearError();
                }}
              >
                <option value="">Choose a person</option>
                {names.map((name) => (
                  <option key={personKey(name)} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {person ? (
              <>
                <p className="gs-muted">
                  {groups
                    .filter((group) => group.personKey === personKey(person))
                    .reduce((sum, group) => sum + group.items.length, 0)}{" "}
                  open items
                </p>
                <div className="gs-balances">
                  <div className="gs-owed">
                    <span>{person} owes you</span>
                    <strong>{formatPaise(personTotals.receivable)}</strong>
                    <PersonBills
                      groups={groups.filter(
                        (group) =>
                          group.personKey === personKey(person) &&
                          group.kind === "receivable",
                      )}
                    />
                  </div>
                  <div className="gs-payable">
                    <span>You owe {person}</span>
                    <strong>{formatPaise(personTotals.payable)}</strong>
                    <PersonBills
                      groups={groups.filter(
                        (group) =>
                          group.personKey === personKey(person) &&
                          group.kind === "payable",
                      )}
                    />
                  </div>
                </div>
                <div
                  className="gs-offset-track"
                  aria-label={`${formatPaise(offset)} cancels out; ${formatPaise(Math.abs(personTotals.net))} remains`}
                >
                  <span
                    className="money-hatch"
                    style={{
                      width: `${Math.max(personTotals.receivable, personTotals.payable) > 0 ? (offset / Math.max(personTotals.receivable, personTotals.payable)) * 100 : 0}%`,
                    }}
                  />
                  <span
                    className={
                      personTotals.net >= 0 ? "gs-owed-fill" : "gs-payable-fill"
                    }
                  >
                    {personTotals.net !== 0 &&
                      `${formatPaise(Math.abs(personTotals.net))} left to ${personTotals.net > 0 ? "receive" : "pay"}`}
                  </span>
                </div>
                <div className="gs-between gs-muted">
                  <span>{formatPaise(offset)} cancels out</span>
                  <span>
                    of{" "}
                    {formatPaise(
                      Math.max(personTotals.receivable, personTotals.payable),
                    )}
                  </span>
                </div>
                <h3 className="gs-person-net">
                  {personTotals.net === 0
                    ? "Your balances cancel out"
                    : personTotals.net > 0
                      ? `${person} pays you `
                      : `You pay ${person} `}
                  {personTotals.net !== 0 && (
                    <strong
                      className={
                        personTotals.net > 0 ? "text-owed-to-me" : "text-i-owe"
                      }
                    >
                      {formatPaise(Math.abs(personTotals.net))}
                    </strong>
                  )}
                </h3>
                <div className="gs-methods">
                  <h3>
                    {personTotals.net > 0
                      ? "How did they pay?"
                      : "How did you pay?"}
                  </h3>
                  {(
                    [
                      [
                        "bank",
                        personTotals.net > 0
                          ? "They sent it to my bank"
                          : "I sent it from my bank",
                        personBank
                          ? `${formatDate(personBank.date)} · ${personBank.description}`
                          : "Choose the matching payment below",
                      ],
                      [
                        "cash",
                        personTotals.net > 0
                          ? "Received in cash"
                          : "Paid in cash",
                        "Record the cash exchanged and cancel out the overlapping balances",
                      ],
                      [
                        "offset",
                        `Just cancel out ${formatPaise(offset)} for now`,
                        `${formatPaise(Math.abs(personTotals.net))} stays open with ${person}`,
                      ],
                    ] as const
                  ).map(([value, title, description]) => (
                    <label
                      className={`gs-option ${method === value ? "is-selected" : ""}`}
                      key={value}
                    >
                      <input
                        type="radio"
                        name={methodName}
                        checked={method === value}
                        onChange={() => {
                          setMethod(value);
                          clearError();
                        }}
                        disabled={
                          (value === "offset" && offset === 0) ||
                          (value !== "offset" && personTotals.net === 0)
                        }
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <span className="gs-money">
                        {formatPaise(
                          value === "offset"
                            ? offset
                            : Math.abs(personTotals.net),
                        )}
                      </span>
                    </label>
                  ))}
                </div>
                {method === "bank" && !payment && (
                  <label className="gs-person-picker">
                    Bank payment
                    <select
                      value={personBank?.id ?? ""}
                      onChange={(event) => {
                        setBankId(event.target.value);
                        clearError();
                      }}
                    >
                      <option value="">Choose a bank payment</option>
                      {matchingPayments.map((source) => (
                        <option key={source.id} value={source.id}>
                          {formatDate(source.date)} · {source.description} ·{" "}
                          {formatPaise(source.amountPaise)}
                        </option>
                      ))}
                    </select>
                    <small className="gs-muted">
                      {matchingPayments.length
                        ? "Check the date and person before confirming."
                        : "No exact payment in the latest 300 bank transactions. You can open an older payment from Transactions."}
                    </small>
                  </label>
                )}
                {method === "bank" && payment && gap !== 0 && (
                  <p className="gs-status gs-warning">
                    This bank payment is {formatPaise(payment.amountPaise)}. Add
                    another person to explain the difference, or leave part of a
                    balance open.
                  </p>
                )}
                {payment && method !== "bank" && (
                  <p className="gs-muted">
                    {method === "cash"
                      ? "Cash is recorded separately."
                      : "Only the overlapping balances are cancelled."}{" "}
                    The bank payment still needs its own explanation.
                  </p>
                )}
                <div className="gs-between gs-person-footer">
                  <p className="gs-muted">
                    {method === "offset"
                      ? `${formatPaise(offset)} cancels out · ${formatPaise(Math.abs(personTotals.net))} stays open`
                      : "Record a payment already made."}
                  </p>
                  <button
                    type="button"
                    className="gs-primary"
                    disabled={!canSave}
                    onClick={submit}
                  >
                    {method === "offset"
                      ? `Cancel out ${formatPaise(offset)}`
                      : "Mark settled"}
                  </button>
                </div>
                <button
                  type="button"
                  className="gs-text-button"
                  onClick={openGroup}
                >
                  + Add person
                </button>
              </>
            ) : (
              <p className="gs-muted">
                Choose a person to see both balances and what cancels out.
              </p>
            )}
          </>
        ) : (
          <>
            <header className="gs-payment">
              <div>
                <p className="gs-muted">
                  {activePayment
                    ? `${activePayment.direction === "credit" ? "Payment received" : "Payment sent"} · ${formatDate(activePayment.date)}`
                    : "Cancel out balances · no bank payment"}
                </p>
                <h3>{defaultPerson || "Bank settlement"}</h3>
                <p className="gs-payment-description">
                  {activePayment?.description ||
                    "Only equal amounts can cancel out without a bank payment."}
                </p>
              </div>
              {activePayment && (
                <div
                  className={`gs-payment-amount ${activePayment.direction === "credit" ? "text-inflow" : "text-i-owe"}`}
                >
                  {formatPaise(activePayment.amountPaise)}
                </div>
              )}
            </header>
            {!payment && (
              <label className="gs-person-picker">
                Bank payment
                <select
                  value={bankId}
                  onChange={(event) => {
                    setBankId(event.target.value);
                    clearError();
                  }}
                >
                  <option value="">Only cancel out balances</option>
                  {bankPayments.map((source) => (
                    <option key={source.id} value={source.id}>
                      {formatDate(source.date)} ·{" "}
                      {source.direction === "credit" ? "Received" : "Sent"}{" "}
                      {formatPaise(source.amountPaise)} · {source.description}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="gs-columns">
              <section className="gs-selection">
                <h3>What does this payment cover?</h3>
                <p className="gs-muted">
                  The amounts may match a possible combination. Confirm the
                  people and bills before saving.
                </p>
                {(["receivable", "payable"] as const).map((kind) => (
                  <div key={kind}>
                    <div className="gs-role-heading">
                      <strong>
                        {kind === "receivable"
                          ? "They owe you"
                          : activePayment?.direction === "credit"
                            ? `${defaultPerson || "The sender"} paid for you`
                            : "You owe them"}
                      </strong>
                      <span>
                        {kind === "receivable"
                          ? "Paid back through this payment"
                          : activePayment?.direction === "credit"
                            ? "Deducted before the rest was sent"
                            : "Bills cleared by this settlement"}
                      </span>
                    </div>
                    <div className="gs-options">
                      {visible
                        .filter((group) => group.kind === kind)
                        .map((group) => (
                          <GroupOption
                            key={group.key}
                            group={group}
                            amount={selection[group.key] ?? 0}
                            onToggle={() => {
                              setSelection((previous) => ({
                                ...previous,
                                [group.key]:
                                  previous[group.key] > 0
                                    ? 0
                                    : group.outstandingPaise,
                              }));
                              clearError();
                            }}
                          />
                        ))}
                      {visible.filter((group) => group.kind === kind).length ===
                        0 && <p className="gs-muted">No one included yet.</p>}
                    </div>
                    {kind === "payable" &&
                      activePayment?.direction === "credit" && (
                        <p className="gs-muted gs-role-help">
                          Include these bills only if the sender has already
                          paid them on your behalf.
                        </p>
                      )}
                  </div>
                ))}
                {available.length > 0 && (
                  <button
                    type="button"
                    className="gs-text-button"
                    onClick={() => setAdding((value) => !value)}
                  >
                    {adding ? "Close people list" : "+ Add another person"}
                  </button>
                )}
                {adding && (
                  <div className="gs-add-people">
                    {available.map((group) => (
                      <button
                        type="button"
                        key={group.key}
                        onClick={() => {
                          setVisibleKeys((keys) => [...keys, group.key]);
                          setSelection((previous) => ({
                            ...previous,
                            [group.key]: group.outstandingPaise,
                          }));
                          setAdding(false);
                          clearError();
                        }}
                      >
                        <span>
                          {group.personName}
                          <small>
                            {group.kind === "receivable"
                              ? "Owes you"
                              : "You owe them"}{" "}
                            · {group.items.length} bill
                            {group.items.length === 1 ? "" : "s"}
                          </small>
                        </span>
                        <span className="gs-money">
                          {formatPaise(group.outstandingPaise)} · Add
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <aside className="gs-summary">
                <h3>
                  {activePayment
                    ? `How ${formatPaise(activePayment.amountPaise)} ${activePayment.direction === "credit" ? "reaches you" : "leaves your bank"}`
                    : "How the balances cancel out"}
                </h3>
                <p className="gs-muted">
                  Repayments, minus bills paid for you.
                </p>
                <div className="gs-math">
                  <div className="gs-between">
                    <span>They pay you back</span>
                    <strong className="gs-money">
                      {formatPaise(totals.receivable)}
                    </strong>
                  </div>
                  {selectedGroups
                    .filter((group) => group.kind === "receivable")
                    .map((group) => (
                      <div
                        className="gs-math-detail gs-between"
                        key={group.key}
                      >
                        <span>{group.personName}</span>
                        <span className="gs-money">
                          {formatPaise(selection[group.key])}
                        </span>
                      </div>
                    ))}
                  <div className="gs-between gs-math-offset">
                    <span>
                      {activePayment?.direction === "credit"
                        ? "Paid for you"
                        : "You owe them"}
                    </span>
                    <strong className="gs-money text-i-owe">
                      −{formatPaise(totals.payable)}
                    </strong>
                  </div>
                  {selectedGroups
                    .filter((group) => group.kind === "payable")
                    .map((group) => (
                      <div
                        className="gs-math-detail gs-between"
                        key={group.key}
                      >
                        <span>To {group.personName}</span>
                        <span className="gs-money">
                          {formatPaise(selection[group.key])}
                        </span>
                      </div>
                    ))}
                  <div className="gs-between gs-math-result">
                    <span>
                      {activePayment?.direction === "debit"
                        ? "Expected from your bank"
                        : "Expected in your bank"}
                    </span>
                    <strong className="gs-money">
                      {formatPaise(
                        activePayment?.direction === "debit"
                          ? -totals.net
                          : totals.net,
                      )}
                    </strong>
                  </div>
                  <div className="gs-between gs-muted">
                    <span>
                      {activePayment?.direction === "debit"
                        ? "Actually sent"
                        : "Actually received"}
                    </span>
                    <strong className="gs-money">
                      {formatPaise(activePayment?.amountPaise ?? 0)}
                    </strong>
                  </div>
                </div>
                <div
                  className={`gs-status ${balanced && anySelected ? "gs-match" : "gs-warning"}`}
                  aria-live="polite"
                >
                  <strong>
                    {!anySelected
                      ? "Choose who this payment covers"
                      : balanced
                        ? activePayment
                          ? "Matches the bank payment"
                          : "Equal balances cancel out"
                        : `${formatPaise(Math.abs(gap))} ${(activePayment?.direction === "debit" ? -gap : gap) > 0 ? "more than the bank amount" : "less than the bank amount"}`}
                  </strong>
                  <p>
                    {balanced
                      ? "Check that the selected people and bills are correct."
                      : "Change the people included, or leave the difference open."}
                  </p>
                  {fix && (
                    <button
                      type="button"
                      className="gs-fix"
                      onClick={() => {
                        setSelection(fix.next);
                        clearError();
                      }}
                    >
                      Count {formatPaise(fix.next[fix.group.key])} from{" "}
                      {fix.group.personName} · leave{" "}
                      {formatPaise(fix.remainingOpenPaise)} open
                    </button>
                  )}
                  {!balanced && (
                    <button
                      type="button"
                      className="gs-text-button"
                      onClick={() => {
                        const suggestion = suggestSettlement(
                          groups,
                          expectedNet,
                          defaultPerson,
                        );
                        setSelection(suggestion);
                        setVisibleKeys(Object.keys(suggestion));
                        clearError();
                      }}
                    >
                      Use suggested people
                    </button>
                  )}
                </div>
                <details className="gs-effects">
                  <summary>What will change</summary>
                  <ul>
                    {selectedGroups.map((group) => (
                      <li key={group.key}>
                        {formatPaise(selection[group.key])}{" "}
                        {group.kind === "receivable"
                          ? `paid back for ${group.personName}`
                          : `you owed ${group.personName} cleared`}
                        {selection[group.key] < group.outstandingPaise
                          ? ` · ${formatPaise(group.outstandingPaise - selection[group.key])} still open`
                          : ""}
                      </li>
                    ))}
                    <li>
                      Unselected balances stay open. Linked repayments are
                      excluded from your spend.
                    </li>
                  </ul>
                </details>
                <button
                  type="button"
                  className="gs-primary"
                  disabled={!canSave}
                  onClick={submit}
                >
                  Confirm settlement for {selectedPeople}{" "}
                  {selectedPeople === 1 ? "person" : "people"}
                </button>
                <p className="gs-muted gs-save-help">
                  This records a payment already made.
                </p>
              </aside>
            </div>
          </>
        )}
      </fieldset>
      {pending && (
        <p className="gs-muted" role="status">
          Saving settlement…
        </p>
      )}
      {error && (
        <div className="gs-status gs-warning" role="alert">
          <p>{error}</p>
          {refreshRequired && (
            <>
              <p>Close and refresh your balances before trying again.</p>
              <button
                type="button"
                className="gs-text-button"
                onClick={onClose}
              >
                Close and refresh
              </button>
            </>
          )}
        </div>
      )}
      {!pending && groups.length === 0 && (
        <p className="gs-muted">
          There are no open balances. Add a split bill or a bill someone paid
          for you first.
        </p>
      )}
    </div>
  );
}

function PersonBills({ groups }: { groups: SettlementGroup[] }) {
  const items = groups.flatMap((group) => group.items);
  return (
    <small>
      {items[0]
        ? `${items[0].description} · ${formatDate(items[0].date)}${items.length > 1 ? ` · +${items.length - 1} more` : ""}`
        : "No open bills"}
    </small>
  );
}

function GroupOption({
  group,
  amount,
  onToggle,
}: {
  group: SettlementGroup;
  amount: number;
  onToggle: () => void;
}) {
  return (
    <div>
      <label className={`gs-option ${amount > 0 ? "is-selected" : ""}`}>
        <input type="checkbox" checked={amount > 0} onChange={onToggle} />
        <span>
          <strong>{group.personName}</strong>
          <small>
            {group.items.length === 1
              ? `${group.items[0].description} · ${formatDate(group.items[0].date)}`
              : `${group.items.length} open bills · oldest ${formatDate(group.items[0].date)}`}
          </small>
          {amount > 0 && amount < group.outstandingPaise && (
            <small className="text-owed-to-me">
              {formatPaise(group.outstandingPaise - amount)} stays open
            </small>
          )}
        </span>
        <span
          className={`gs-money ${group.kind === "payable" ? "text-i-owe" : ""}`}
        >
          {formatPaise(amount || group.outstandingPaise)}
        </span>
      </label>
      {group.items.length > 1 && (
        <details className="gs-bills">
          <summary>View bills</summary>
          <ul>
            {group.items.map((item) => (
              <li key={item.id}>
                {item.description} · {formatDate(item.date)} ·{" "}
                {formatPaise(item.outstandingPaise)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
