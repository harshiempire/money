export default function FinanceLoading() {
  return (
    <main className="mx-auto max-w-6xl animate-pulse p-8">
      <div className="flex items-baseline justify-between">
        <div className="h-8 w-48 rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-4 w-64 rounded bg-neutral-200 dark:bg-neutral-800" />
      </div>
      <div className="mt-6 h-4 w-full max-w-md rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-20 rounded border border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900"
          />
        ))}
      </div>
      <div className="mt-8 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-10 rounded bg-neutral-200 dark:bg-neutral-800"
          />
        ))}
      </div>
    </main>
  );
}
