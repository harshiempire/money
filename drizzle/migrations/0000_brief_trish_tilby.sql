CREATE TYPE "public"."category_kind" AS ENUM('spend', 'transfer', 'reimbursement', 'investment', 'income');--> statement-breakpoint
CREATE TYPE "public"."txn_channel" AS ENUM('upi', 'imps', 'neft', 'rtgs', 'cheque', 'cash', 'card', 'opening', 'other');--> statement-breakpoint
CREATE TYPE "public"."counterparty_kind" AS ENUM('upi_handle', 'merchant', 'imps_payee', 'neft_payee', 'self');--> statement-breakpoint
CREATE TYPE "public"."dr_cr" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."rule_match_kind" AS ENUM('counterparty', 'regex');--> statement-breakpoint
CREATE TABLE "account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"kind" "category_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparty" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "counterparty_kind" NOT NULL,
	"key" text NOT NULL,
	"display_name" text,
	"default_category_id" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"is_family" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"bank" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_new" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "money_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"bank" text NOT NULL,
	"opening_balance_paise" bigint NOT NULL,
	"opening_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"match_kind" "rule_match_kind" NOT NULL,
	"pattern" text NOT NULL,
	"category_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement" (
	"id" text PRIMARY KEY NOT NULL,
	"inflow_transaction_id" text NOT NULL,
	"split_participant_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "split_participant" (
	"id" text PRIMARY KEY NOT NULL,
	"split_id" text NOT NULL,
	"person_name" text NOT NULL,
	"expected_amount_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "split" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"total_paise" bigint NOT NULL,
	"your_share_paise" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_tag" (
	"transaction_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "transaction_tag_transaction_id_tag_id_pk" PRIMARY KEY("transaction_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"txn_date" date NOT NULL,
	"value_date" date,
	"amount_paise" bigint NOT NULL,
	"dr_cr" "dr_cr" NOT NULL,
	"channel" "txn_channel" NOT NULL,
	"ref_id" text NOT NULL,
	"raw_description" text NOT NULL,
	"parsed_purpose" text,
	"counterparty_id" text,
	"category_id" text,
	"is_transfer" boolean DEFAULT false NOT NULL,
	"balance_paise" bigint,
	"source_import_id" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"emailVerified" timestamp,
	"image" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import" ADD CONSTRAINT "import_account_id_money_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_account" ADD CONSTRAINT "money_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_inflow_transaction_id_transaction_id_fk" FOREIGN KEY ("inflow_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_split_participant_id_split_participant_id_fk" FOREIGN KEY ("split_participant_id") REFERENCES "public"."split_participant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split_participant" ADD CONSTRAINT "split_participant_split_id_split_id_fk" FOREIGN KEY ("split_id") REFERENCES "public"."split"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "split" ADD CONSTRAINT "split_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tag" ADD CONSTRAINT "transaction_tag_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tag" ADD CONSTRAINT "transaction_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_money_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_counterparty_id_counterparty_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_source_import_id_import_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_user_name_uniq" ON "category" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_user_key_uniq" ON "counterparty" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_user_name_uniq" ON "tag" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "txn_account_ref_uniq" ON "transaction" USING btree ("account_id","ref_id");--> statement-breakpoint
CREATE INDEX "txn_account_date_idx" ON "transaction" USING btree ("account_id","txn_date");