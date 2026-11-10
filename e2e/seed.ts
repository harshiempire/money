/**
 * Made-up user and data for the browser tests. Resets every table, so it is
 * safe to re-run, and it refuses any database except a local one named
 * money_e2e. Run alone with: node e2e/seed.ts (needs E2E_DATABASE_URL).
 *
 * Only `postgres` and `bcryptjs` are imported, so plain Node can run this file
 * and it never reaches src/db/index.ts.
 */
import bcrypt from "bcryptjs";
import postgres, { type Sql } from "postgres";
import { pathToFileURL } from "node:url";

/** Only ever exists in throwaway test databases, so committing it is fine. */
export const E2E_EMAIL = "demo@money.local";
export const E2E_PASSWORD = "e2e-password-not-a-secret";
export const AUTH_FILE = "e2e/.auth/user.json";

// Low cost keeps reseeding fast; the login form checks any bcrypt cost the same way.
const passwordHash = bcrypt.hashSync(E2E_PASSWORD, 4);

export function e2eDatabaseUrl(): string {
  const raw = process.env.E2E_DATABASE_URL;
  if (!raw) throw new Error("Set E2E_DATABASE_URL to a local money_e2e database.");
  const url = new URL(raw);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/money_e2e") {
    throw new Error("E2E_DATABASE_URL must be a local database named money_e2e.");
  }
  return raw;
}

export const connectE2e = (): Sql =>
  postgres(e2eDatabaseUrl(), { max: 2, onnotice: () => {} });

const DATA = `
insert into money_account(id,user_id,name,bank,opening_balance_paise,opening_date) values
 ('demo-acct','demo-user','Demo bank','bob',10000000,'2026-10-01');
insert into import(id,account_id,filename,sha256,bank,period_start,period_end,rows_seen,rows_new) values
 ('demo-import','demo-acct','demo-october.pdf','demo','bob','2026-10-01','2026-10-31',7,7);

insert into category(id,user_id,name,kind) values
 ('c-food','demo-user','Food','spend'),('c-travel','demo-user','Travel','spend'),
 ('c-fun','demo-user','Entertainment','spend'),('c-groc','demo-user','Groceries','spend'),
 ('c-sal','demo-user','Salary','income'),
 -- The app's other default categories. If they were missing, simultaneous
 -- first page loads would both try to add them.
 ('c-shop','demo-user','Shopping','spend'),('c-subs','demo-user','Subscriptions','spend'),
 ('c-bills','demo-user','Bills','spend'),('c-other','demo-user','Other spend','spend'),
 ('c-self','demo-user','Self transfer','transfer'),('c-family','demo-user','Family','transfer'),
 ('c-invest','demo-user','Investment','investment'),('c-reimb','demo-user','Reimbursement','reimbursement'),
 ('c-income','demo-user','Income','income');

insert into person(id,user_id,name) values
 ('p-neha','demo-user','Neha'),('p-arjun','demo-user','Arjun'),
 ('p-priya','demo-user','Priya'),('p-kabir','demo-user','Kabir');

insert into counterparty(id,user_id,kind,key,display_name,person_id) values
 ('cp-neha','demo-user','upi_handle','neha.demo@upi','Neha','p-neha'),
 ('cp-arjun','demo-user','upi_handle','arjun.demo@upi','Arjun','p-arjun'),
 ('cp-uber','demo-user','merchant','uber','Uber',null),
 ('cp-rest','demo-user','merchant','spice-garden','Spice Garden',null),
 ('cp-pvr','demo-user','merchant','cinema','City Cinema',null),
 ('cp-groc','demo-user','merchant','freshmart','FreshMart',null),
 ('cp-sal','demo-user','neft_payee','demo-employer','Demo Employer',null);

insert into "transaction"(id,account_id,txn_date,amount_paise,dr_cr,channel,ref_id,raw_description,counterparty_id,category_id,balance_paise,source_import_id) values
 ('t-salary','demo-acct','2026-10-03',6000000,'credit','neft','demo1','NEFT/Demo Employer/Salary','cp-sal','c-sal',16000000,'demo-import'),
 ('t-uber','demo-acct','2026-10-05',120000,'debit','upi','demo2','UPI/uber/Airport cab','cp-uber','c-travel',15880000,'demo-import'),
 ('t-dinner','demo-acct','2026-10-08',600000,'debit','upi','demo3','UPI/spice-garden/Team dinner','cp-rest','c-food',15280000,'demo-import'),
 ('t-movie','demo-acct','2026-10-10',160000,'debit','upi','demo4','UPI/cinema/Movie night','cp-pvr','c-fun',15120000,'demo-import'),
 ('t-groc','demo-acct','2026-10-12',234500,'debit','upi','demo5','UPI/freshmart/Groceries','cp-groc','c-groc',14885500,'demo-import'),
 ('t-to-neha','demo-acct','2026-10-20',125000,'debit','upi','demo6','UPI/neha.demo@upi/Settling up','cp-neha',null,14760500,'demo-import'),
 ('t-from-arjun','demo-acct','2026-10-22',350000,'credit','upi','demo7','UPI/arjun.demo@upi/Dinner money','cp-arjun',null,15110500,'demo-import');

insert into split(id,transaction_id,total_paise,your_share_paise,note) values
 ('s-uber','t-uber',120000,60000,'Airport cab'),
 ('s-dinner','t-dinner',600000,250000,'Team dinner'),
 ('s-movie','t-movie',160000,80000,'Movie night');
insert into split_participant(id,split_id,person_id,person_name,expected_amount_paise) values
 ('sp-neha-uber','s-uber','p-neha','Neha',60000),
 ('sp-arjun-dinner','s-dinner','p-arjun','Arjun',200000),
 ('sp-priya-dinner','s-dinner','p-priya','Priya',150000),
 ('sp-kabir-movie','s-movie','p-kabir','Kabir',80000);

insert into owed_expense(id,user_id,person_id,person_name,incurred_date,amount_paise,description,category_id) values
 ('o-neha-dinner','demo-user','p-neha','Neha','2026-10-07',185000,'Birthday dinner Neha paid for','c-food');
`;

export async function seedDatabase(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    const tables = await tx<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'`;
    const list = tables.map((t) => `"${t.tablename}"`).join(", ");
    await tx.unsafe(`truncate ${list} restart identity cascade`);
    await tx`insert into "user"(id, name, email, password_hash)
             values ('demo-user', 'Demo', ${E2E_EMAIL}, ${passwordHash})`;
    await tx.unsafe(DATA);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = connectE2e();
  await seedDatabase(sql);
  await sql.end();
  console.log("Seeded money_e2e.");
}
