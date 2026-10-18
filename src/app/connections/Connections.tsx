"use client";

import { useRef, useState, type FormEvent } from "react";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "./actions";

type Token = Awaited<ReturnType<typeof listMcpTokens>>[number];

const buttonClass =
  "rounded border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-100 " +
  "disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const fieldClass =
  "w-full min-w-0 rounded border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700";

function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

export function Connections({
  initialTokens,
  initialError,
}: {
  initialTokens: Token[];
  initialError?: string;
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "propose">("read");
  const [created, setCreated] = useState<{
    token: string;
    command: string;
  } | null>(null);
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? null);
  const inFlight = useRef(false);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || created || !name.trim() || name.trim().length > 40) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await createMcpToken({
        name: name.trim(),
        scope,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreated({
        token: res.token,
        command:
          `claude mcp add --transport http money ${window.location.origin}/api/mcp ` +
          `--header "Authorization: Bearer ${res.token}"`,
      });
      setCopied(null);
      setTokens((prev) => [
        {
          id: res.id,
          name: name.trim(),
          hint: res.hint,
          scope,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        ...prev,
      ]);
      setName("");
      try {
        setTokens(await listMcpTokens());
      } catch {
        setError("Token created, but the list couldn't refresh. Copy it now, then reload the page.");
      }
    } catch {
      setError("Couldn't create a token. Reload the list before trying again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (inFlight.current || confirmId !== id) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await revokeMcpToken({ id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTokens((prev) =>
        prev.map((token) =>
          token.id === id
            ? {
                ...token,
                revokedAt: new Date().toISOString(),
              }
            : token,
        ),
      );
      setConfirmId(null);
    } catch {
      setError("Couldn't confirm the token was revoked. Reload the page to check its status.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const copy = async (kind: "token" | "command") => {
    if (!created) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(created[kind]);
      setCopied(kind);
    } catch {
      setError("Couldn't copy. Select the field and copy it yourself.");
    }
  };

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {created && (
        <section
          aria-label="Your new token"
          className={
            "space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 " +
            "dark:border-amber-800 dark:bg-amber-950/30"
          }
        >
          <h2 className="text-sm font-semibold">Copy it now. You won&apos;t see it again.</h2>
          <div>
            <label htmlFor="mcp-token" className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
              Token
            </label>
            <input
              id="mcp-token"
              readOnly
              value={created.token}
              onFocus={(e) => e.target.select()}
              autoComplete="off"
              spellCheck={false}
              className={`${fieldClass} font-mono text-xs`}
            />
            <button type="button" onClick={() => void copy("token")} className={`mt-2 ${buttonClass}`}>
              {copied === "token" ? "Copied" : "Copy token"}
            </button>
          </div>
          <div>
            <label
              htmlFor="mcp-command"
              className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400"
            >
              Add to Claude Code
            </label>
            <textarea
              id="mcp-command"
              readOnly
              value={created.command}
              onFocus={(e) => e.target.select()}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              className={`${fieldClass} break-all font-mono text-xs`}
            />
            <button type="button" onClick={() => void copy("command")} className={`mt-2 ${buttonClass}`}>
              {copied === "command" ? "Copied" : "Copy command"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setCreated(null);
              setCopied(null);
            }}
            className={buttonClass}
          >
            Done, hide token
          </button>
        </section>
      )}

      <form onSubmit={(event) => void create(event)} className="space-y-4">
        <h2 className="text-lg font-semibold">Create a token</h2>
        <div>
          <label htmlFor="mcp-name" className="mb-1 block text-sm">
            Name
          </label>
          <input
            id="mcp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={1}
            maxLength={40}
            placeholder="Claude Code"
            disabled={busy || Boolean(created)}
            className={fieldClass}
          />
        </div>
        <fieldset disabled={busy || Boolean(created)} className="space-y-3">
          <legend className="mb-2 text-sm">Access</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value="read"
              checked={scope === "read"}
              onChange={() => setScope("read")}
              className="mt-1"
            />
            <span>
              Read
              <span className="block text-xs text-neutral-500">
                Read categories, transactions, period summary and notes.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value="propose"
              checked={scope === "propose"}
              onChange={() => setScope("propose")}
              className="mt-1"
            />
            <span>
              Read + propose tags
              <span className="block text-xs text-neutral-500">
                Also store tag drafts for you to review in Ask Money.
              </span>
            </span>
          </label>
        </fieldset>
        <button
          type="submit"
          disabled={busy || Boolean(created) || !name.trim()}
          className={
            "rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white " +
            "disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          }
        >
          {busy ? "Working…" : "Create token"}
        </button>
      </form>

      <section aria-labelledby="mcp-tokens-heading">
        <h2 id="mcp-tokens-heading" className="text-lg font-semibold">
          Your tokens
        </h2>
        {tokens.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">No tokens yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
            {tokens.map((token) => (
              <li key={token.id} className={`py-4 ${token.revokedAt ? "text-neutral-500" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium">{token.name}</span>
                  <span className="text-xs text-neutral-500">
                    {token.revokedAt ? "Revoked" : "Active"} ·{" "}
                    {token.scope === "read" ? "Read" : "Read + propose tags"}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-neutral-500">{token.hint}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Created {dateLabel(token.createdAt)} · Last used{" "}
                  {token.lastUsedAt ? dateLabel(token.lastUsedAt) : "Never"}
                </p>
                {!token.revokedAt &&
                  (confirmId === token.id ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <p className="w-full text-xs">Revoke this token? Any tool using it will lose access.</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void revoke(token.id)}
                        className={`${buttonClass} text-red-600 dark:text-red-400`}
                      >
                        Yes, revoke
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmId(null)}
                        className={buttonClass}
                      >
                        Keep token
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(token.id)}
                      className={`mt-3 ${buttonClass}`}
                    >
                      Revoke
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
