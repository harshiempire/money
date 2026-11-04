import { expect, test } from 'bun:test';
import { buildPersonBalances, outstandingPaise, type BalanceLine } from './balances';
const line = (id:string, extra:Partial<BalanceLine> = {}): BalanceLine => ({ id,personName:'Kiran',date:'2026-01-01',what:'Meal',amountPaise:1000,settledRows:[],...extra });
test('all settlement methods count, partial and overpaid shares clamp separately', () => {
  const rows = ['bank','cash','offset','writeoff'].map(method => ({method,amountPaise:100}));
  expect(outstandingPaise(1000,rows)).toBe(600);
  expect(outstandingPaise(200,rows)).toBe(0);
  expect(buildPersonBalances({people:[],shares:[line('a',{settledRows:rows}),line('b',{amountPaise:200,settledRows:rows})],owed:[]})![0].owedToYouPaise).toBe(600);
});
test('integer inputs and aggregates must be safe; rules return refusal rather than throw', () => {
  for(const n of [NaN,Infinity,1.1,-1,Number.MAX_SAFE_INTEGER+1]) expect(outstandingPaise(n,[])).toBeNull();
  expect(outstandingPaise(1,[{amountPaise:Number.MAX_SAFE_INTEGER},{amountPaise:1}])).toBeNull();
  expect(buildPersonBalances({people:[],shares:[line('a',{amountPaise:Number.MAX_SAFE_INTEGER}),line('b')],owed:[]})).toBeNull();
});
test('id beats renamed spelling, unknown names trim, equal names on distinct ids stay separate', () => {
  const p = buildPersonBalances({people:[{id:'one',name:'Kiran'},{id:'two',name:'KIRAN '}],
    shares:[line('a',{personId:'one',personName:'Old spelling'}),line('b',{personId:'two'}),line('c',{personName:' Arjun '}),line('d',{personName:'arjun',date:'2026-02-01'})],owed:[line('e',{personId:'one',amountPaise:500})]})!;
  expect(p).toHaveLength(3);
  expect(p.find(p=>p.personId==='one')).toMatchObject({name:'Kiran',owedToYouPaise:1000,youOwePaise:500,netPaise:500});
  expect(p.find(p=>p.personId==='two')!.owedToYouPaise).toBe(1000);
  expect(p.find(p=>!p.personId)).toMatchObject({name:'arjun',owedToYouPaise:2000});
});
test('oldest bill first then split creation order; owed oldest first', () => {
  const p = buildPersonBalances({people:[],shares:[line('b',{order:'02'}),line('c',{date:'2026-02-01'}),line('a',{order:'01'})],owed:[line('y',{date:'2026-02-01'}),line('x')]})![0];
  expect(p.shares.map(s=>s.id)).toEqual(['a','b','c']);
  expect(p.owed.map(s=>s.id)).toEqual(['x','y']);
});

for (const personId of [null, '']) {
  test(`missing ID (${JSON.stringify(personId)}) resolves a unique saved folded name for shares and owed`, () => {
    const balances = buildPersonBalances({ people: [{ id: 'saved', name: 'Ravi Teja' }],
      shares: [line('share', { personId, personName: '  rAVI tEJA ' })],
      owed: [line('owed', { personId, personName: ' RAVI TEJA ', amountPaise: 300 })] })!;
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ key: 'id:saved', personId: 'saved', name: 'Ravi Teja', owedToYouPaise: 1000, youOwePaise: 300 });
  });
}
test('missing ID with no saved folded-name match keeps the name group', () => {
  const balances = buildPersonBalances({ people: [{ id: 'saved', name: 'Arjun' }],
    shares: [line('share', { personId: null, personName: '  rAVI tEJA ' })], owed: [] })!;
  expect(balances).toHaveLength(2);
  expect(balances.find(p => p.openShareCount)).toMatchObject({ key: 'name:ravi teja', personId: null, owedToYouPaise: 1000 });
});
test('missing ID with multiple saved folded-name matches keeps the name group without guessing', () => {
  const balances = buildPersonBalances({ people: [{ id: 'one', name: 'Kiran' }, { id: 'two', name: ' KIRAN ' }],
    shares: [line('share', { personId: null, personName: ' kIRAN ' })],
    owed: [line('owed', { personId: '', personName: 'KIRAN', amountPaise: 300 })] })!;
  expect(balances).toHaveLength(3);
  expect(balances.find(p => p.key === 'name:kiran')).toMatchObject({ personId: null, owedToYouPaise: 1000, youOwePaise: 300 });
  expect(balances.filter(p => p.personId).every(p => p.owedToYouPaise === 0 && p.youOwePaise === 0)).toBe(true);
});
