import { outstandingPaise } from '../rules/balances';
import { LedgerError } from '../context';
/** Promise adapters refuse unsafe money with the same domain error as Effect readers. */
export function readOutstanding(expected: number, settled: number): number {
  const result = outstandingPaise(expected, [{ amountPaise: settled }]);
  if (result === null) throw new LedgerError({ code: 'invalid_amount', message: 'Balance exceeds the exact integer paise range.' });
  return result;
}
