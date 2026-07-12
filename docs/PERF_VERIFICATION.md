# Performance change verification checklist

Run after each performance phase before merging.

## Automated

```bash
bun run typecheck
bun run build
bun test
bun run perf:http-pages   # requires dev server + BOOTSTRAP_* env
```

## Manual — tenant isolation

- [ ] Log in as seed/bootstrap user — historical transactions and imports visible
- [ ] Register or log in as a second user — empty dashboard, no cross-tenant data

## Manual — spend semantics

- [ ] Debit with a split: footer/dashboard net uses `your_share`, not full amount
- [ ] Settlement credit excluded from net spend (not double-counted)
- [ ] Dashboard headline net matches `/spend` for the same period

## Manual — splits and settlements

- [ ] SettleDialog lists all account participants (including fully settled splits)
- [ ] Open receivables picker shows only participants with outstanding > 0
- [ ] Recording a settlement updates receivables without stale totals after navigation

## Manual — statement mode

- [ ] Dashboard default (no query params) uses latest import period
- [ ] Previous-period comparison compares adjacent statements, not calendar months

## Manual — review page

- [ ] `/review` shows only `needsReview` transactions
- [ ] SettleDialog participant options remain account-wide (not period-filtered)

## Manual — reimbursements

- [ ] Payment in month M for expense in month M-1: period columns unchanged
- [ ] `/reimbursements` open receivables/payables match pre-change behavior
