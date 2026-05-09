import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  date,
  uniqueIndex,
  index,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const drCrEnum = pgEnum("dr_cr", ["debit", "credit"]);
export const channelEnum = pgEnum("txn_channel", [
  "upi",
  "imps",
  "neft",
  "rtgs",
  "cheque",
  "cash",
  "card",
  "opening",
  "other",
]);
export const counterpartyKindEnum = pgEnum("counterparty_kind", [
  "upi_handle",
  "merchant",
  "imps_payee",
  "neft_payee",
  "self",
]);
export const categoryKindEnum = pgEnum("category_kind", [
  "spend",
  "transfer",
  "reimbursement",
  "investment",
  "income",
]);
export const ruleMatchKindEnum = pgEnum("rule_match_kind", [
  "counterparty",
  "regex",
]);

// ─── Auth tables (Auth.js drizzle adapter expects these exact names) ─────────

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accountsAuth = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
  }),
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier, t.token] }),
  }),
);

// ─── Domain tables ───────────────────────────────────────────────────────────

// Bank/wallet account that holds money. (Distinct from Auth.js's `account`.)
export const moneyAccounts = pgTable("money_account", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  bank: text("bank").notNull(), // "bob" | "icici" | ...
  // Money stored as paise (integer) to avoid float drift.
  openingBalancePaise: bigint("opening_balance_paise", {
    mode: "number",
  }).notNull(),
  openingDate: date("opening_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const counterparties = pgTable(
  "counterparty",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: counterpartyKindEnum("kind").notNull(),
    key: text("key").notNull(), // e.g. "swiggy580017.rzp@rx" or "GR0WW INVEST TECH PVT LTD"
    displayName: text("display_name"),
    defaultCategoryId: text("default_category_id"),
    isSelf: boolean("is_self").default(false).notNull(),
    isFamily: boolean("is_family").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqUserKey: uniqueIndex("counterparty_user_key_uniq").on(t.userId, t.key),
  }),
);

export const categories = pgTable(
  "category",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    kind: categoryKindEnum("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqUserName: uniqueIndex("category_user_name_uniq").on(t.userId, t.name),
  }),
);

export const imports = pgTable("import", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  accountId: text("account_id")
    .notNull()
    .references(() => moneyAccounts.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  sha256: text("sha256").notNull(),
  bank: text("bank").notNull(),
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }),
  rowsSeen: integer("rows_seen").notNull().default(0),
  rowsNew: integer("rows_new").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const transactions = pgTable(
  "transaction",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "cascade" }),
    txnDate: date("txn_date", { mode: "string" }).notNull(),
    valueDate: date("value_date", { mode: "string" }),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    drCr: drCrEnum("dr_cr").notNull(),
    channel: channelEnum("channel").notNull(),
    refId: text("ref_id").notNull(), // either parsed bank ref or fallback hash
    rawDescription: text("raw_description").notNull(),
    parsedPurpose: text("parsed_purpose"),
    counterpartyId: text("counterparty_id").references(() => counterparties.id),
    categoryId: text("category_id").references(() => categories.id),
    isTransfer: boolean("is_transfer").default(false).notNull(),
    balancePaise: bigint("balance_paise", { mode: "number" }),
    sourceImportId: text("source_import_id").references(() => imports.id, {
      onDelete: "set null",
    }),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // The big idea: dedup across overlapping statements via (account, ref_id).
    uniqAccountRef: uniqueIndex("txn_account_ref_uniq").on(t.accountId, t.refId),
    byAccountDate: index("txn_account_date_idx").on(t.accountId, t.txnDate),
  }),
);

export const splits = pgTable("split", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  transactionId: text("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
  yourSharePaise: bigint("your_share_paise", { mode: "number" }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const splitParticipants = pgTable("split_participant", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  splitId: text("split_id")
    .notNull()
    .references(() => splits.id, { onDelete: "cascade" }),
  personName: text("person_name").notNull(),
  expectedAmountPaise: bigint("expected_amount_paise", {
    mode: "number",
  }).notNull(),
});

export const settlements = pgTable("settlement", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  inflowTransactionId: text("inflow_transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  splitParticipantId: text("split_participant_id")
    .notNull()
    .references(() => splitParticipants.id, { onDelete: "cascade" }),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const rules = pgTable("rule", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  matchKind: ruleMatchKindEnum("match_kind").notNull(),
  pattern: text("pattern").notNull(),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const tags = pgTable(
  "tag",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => ({
    uniqUserName: uniqueIndex("tag_user_name_uniq").on(t.userId, t.name),
  }),
);

export const transactionTags = pgTable(
  "transaction_tag",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.transactionId, t.tagId] }),
  }),
);
