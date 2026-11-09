import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
const enabled = process.env.MONEY_LEDGER_TEST_DB === "1";
if (enabled && !process.env.DATABASE_URL)
  throw new Error(
    "MONEY_LEDGER_TEST_DB requires an explicitly supplied DATABASE_URL. Do not load .env files.",
  );
const readUrl = (file: string | undefined) => {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
};
if (enabled && process.env.DATABASE_URL !== readUrl(process.env.MONEY_LEDGER_TEST_DBURL_FILE))
  throw new Error("Ledger DB tests run only against the throwaway URL in MONEY_LEDGER_TEST_DBURL_FILE.");
if (enabled) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || target.port !== "54330" || target.pathname !== "/money_test")
    throw new Error("Ledger DB tests require the authorized local money_test database.");
}


describe.skipIf(!enabled)('shared balance adapters on local Docker DB', () => {
  test('identity, all methods, ordering, links and exact totals agree across every door', async () => {
    const {db,schema} = await import('@/db');
    const {listPersonBalances,getPersonDetail} = await import('@/lib/people/ledger');
    const {loadOpenLinesForPerson} = await import('@/lib/assistant/data');
    const {loadBalances} = await import('./read/balances');
    const {runLedger} = await import('./run');
    const {mcpReadOps} = await import('@/lib/mcp/read-ops');
    const {buildReadView,getOpenBalances} = await import('@/lib/mcp/model-view');
    const {buildMcpQueryTables} = await import('@/lib/mcp/query-tables');
    const id = () => crypto.randomUUID();
    const actor={userId:id(),accountId:id()};
    const people=[{id:id(),name:'Kiran'},{id:id(),name:'KIRAN '},{id:id(),name:'Arjun'}];
    const bills=[id(),id(),id()], splits=[id(),id(),id()], shares=[id(),id(),id(),id(),id()];
    const owed=id(),cp=id(),event=id();
    await db.insert(schema.users).values({id:actor.userId,email:`${actor.userId}@balance.test`});
    try {
      await db.insert(schema.moneyAccounts).values({id:actor.accountId,userId:actor.userId,bank:'bob',name:'Test',openingDate:'2026-01-01',openingBalancePaise:0});
      await db.insert(schema.persons).values(people.map(p => ({...p,userId:actor.userId})));
      await db.insert(schema.counterparties).values({id:cp,userId:actor.userId,personId:people[0].id,key:'test-payee',kind:'merchant',displayName:'Meals'});
      await db.insert(schema.transactions).values(bills.map((b,i)=>({id:b,accountId:actor.accountId,txnDate:i===0?'2026-02-01':'2026-01-01',amountPaise:2000,drCr:'debit' as const,channel:'other' as const,refId:id(),rawDescription:'Meal',counterpartyId:cp})));
      await db.insert(schema.splits).values(splits.map((s,i)=>({id:s,transactionId:bills[i],totalPaise:2000,yourSharePaise:1000,createdAt:new Date(`2026-01-0${i+1}T00:00:00Z`)})));
      await db.insert(schema.splitParticipants).values(shares.map((s,i)=>({id:s,splitId:splits[i%3],personId:i===4?null:people[i%3].id,personName:i===4?'  aRjUn ':i===0?'Previous name':people[i%3].name,expectedAmountPaise:1000})));
      await db.insert(schema.owedExpenses).values({id:owed,userId:actor.userId,personId:people[0].id,personName:'Previous name ',incurredDate:'2026-01-01',description:'Tickets',amountPaise:700});
      await db.insert(schema.netEvents).values({id:event,userId:actor.userId,eventDate:'2026-03-01'});
      await db.insert(schema.settlements).values([
        {splitParticipantId:shares[0],amountPaise:100,method:'bank'},
        {splitParticipantId:shares[0],amountPaise:100,method:'cash'},
        {splitParticipantId:shares[0],amountPaise:100,method:'writeoff'},
        {splitParticipantId:shares[0],amountPaise:100,method:'offset',netEventId:event},
        {owedExpenseId:owed,amountPaise:100,method:'offset',netEventId:event},
        {splitParticipantId:shares[2],amountPaise:1500,method:'cash'},
      ]);
      const core=await runLedger(loadBalances(),actor), app=await listPersonBalances(actor.userId);
      const model=await mcpReadOps.readModel!(actor);
      const view=buildReadView(model,actor,new Uint8Array(32).fill(1),new Uint8Array(32).fill(2));
      const overview=await mcpReadOps.overview(actor), open=getOpenBalances(view);
      const sql=buildMcpQueryTables(view,[],[]);
      expect(view.people).toHaveLength(3);
      expect(core.find(p=>p.personId===people[2].id)).toMatchObject({owedToYouPaise:1000,openShareCount:1});
      expect(view.shares[4].person).toBe('Arjun');
      expect(view.people[0].linked_payees).toHaveLength(0); // Arjun sorts first
      for (const p of core) {
        const index=core.indexOf(p), mcp=view.people[index];
        expect(mcp.owed_to_you).toBe((p.owedToYouPaise/100).toFixed(2));
        expect(mcp.you_owe).toBe((p.youOwePaise/100).toFixed(2));
        expect(mcp.open_share_count).toBe(p.openShareCount);
        expect(mcp.linked_payees.map(l=>[l.key,l.display_name])).toEqual(p.linkedPayees.map(l=>[l.key,l.displayName]));
        expect(sql.find(t=>t.name==='people')!.rows[index]).toEqual([p.name,p.owedToYouPaise,p.youOwePaise]);
        if (!p.openShareCount && !p.openOwedCount) continue;
        const a=app.find(a=>a.personId===p.personId)!;
        const linked=[...new Set(p.linkedPayees.map(l=>l.displayName?.trim()||l.key))];
        expect(a.linkedPayees).toEqual(linked);
        expect(a).toMatchObject({receivableOutstandingPaise:p.owedToYouPaise,payableOutstandingPaise:p.youOwePaise,netPaise:p.netPaise});
        const detail=await getPersonDetail(actor.userId,p.personId!);
        expect(detail!.linkedPayees).toEqual(linked);
        expect(detail).toMatchObject({receivableOutstandingPaise:p.owedToYouPaise,payableOutstandingPaise:p.youOwePaise,netPaise:p.netPaise});
        expect(detail!.receivables.map(r=>[r.participantId,r.outstandingPaise])).toEqual(p.shares.map(s=>[s.id,s.leftPaise]));
        expect(detail!.payables.map(r=>[r.owedExpenseId,r.outstandingPaise])).toEqual(p.owed.map(o=>[o.id,o.leftPaise]));
        const ai=await loadOpenLinesForPerson(actor.accountId,actor.userId,p.personId!);
        expect(ai.recv.map(r=>[r.id,r.outstandingPaise])).toEqual(p.shares.map(s=>[s.id,s.leftPaise]));
        expect(ai.pay.map(r=>[r.id,r.outstandingPaise])).toEqual(p.owed.map(o=>[o.id,o.leftPaise]));
        const targets=view.personTargets.get(mcp)!;
        const mcpOpen=open.people.filter(o=>o.name===p.name).find(o=>o.lines.some(l=>targets.shares.has(l.ref) || targets.owed.has(l.ref)))!;
        expect(mcpOpen.lines.map(l=>l.left).sort()).toEqual([...p.shares,...p.owed].map(l=>(l.leftPaise/100).toFixed(2)).sort());
        expect(overview.people.some(o=>o.name===p.name && o.owed_to_you===mcp.owed_to_you && o.you_owe===mcp.you_owe)).toBe(true);
      }
      const shareSql=sql.find(t=>t.name==='shares')!.rows;
      expect(shareSql.map(r=>[r[3],r[4],r[5]]).sort((a,b)=>Number(a[1])-Number(b[1]))).toEqual([[1000,0,1000],[1000,0,1000],[1000,0,1000],[1000,400,600],[1000,1500,0]]);
      expect(sql.find(t=>t.name==='owed')!.rows.map(r=>r.slice(4))).toEqual([[700,100,600]]);
      expect(core.find(p=>p.personId===people[0].id)).toMatchObject({owedToYouPaise:1600,youOwePaise:600,linkedPayees:[{key:'test-payee',displayName:'Meals'}]});
    } finally {
      await db.delete(schema.transactions).where(eq(schema.transactions.accountId,actor.accountId));
      await db.delete(schema.users).where(eq(schema.users.id,actor.userId));
    }
  });
});
