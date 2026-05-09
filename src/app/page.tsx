export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold">Money</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        Split-aware net spend tracker.
      </p>
      <ul className="mt-6 space-y-1 text-sm">
        <li>
          <a className="underline" href="/transactions">
            /transactions
          </a>{" "}
          — list, filter by period and channel
        </li>
        <li>
          <a className="underline" href="/import">
            /import
          </a>{" "}
          — upload a Bank of Baroda PDF statement
        </li>
      </ul>
    </main>
  );
}
