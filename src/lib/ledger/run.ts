import 'server-only';
import { Effect } from 'effect';
import { db } from '@/db';
import { Actor, Db } from './services';
export function runLedger<A, E>(effect: Effect.Effect<A, E, Db | Actor>, actor: Actor['Service']): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provideService(Db, db), Effect.provideService(Actor, actor)));
}
