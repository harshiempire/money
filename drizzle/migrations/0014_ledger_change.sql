CREATE TABLE "ledger_change" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"source" text NOT NULL,
	"token_id" text,
	"source_label" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"ops" jsonb NOT NULL,
	"undoes_change_id" text,
	"undone_by_change_id" text,
	"idempotency_key" text,
	"request_hash" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_change_source_check" CHECK ("ledger_change"."source" in ('app', 'mcp')),
	CONSTRAINT "ledger_change_summary_check" CHECK ("ledger_change"."summary" is null or length("ledger_change"."summary") <= 200)
);
--> statement-breakpoint
ALTER TABLE "mcp_token" DROP CONSTRAINT "mcp_token_scope_check";--> statement-breakpoint
ALTER TABLE "ledger_change" ADD CONSTRAINT "ledger_change_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_change" ADD CONSTRAINT "ledger_change_account_id_money_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_change" ADD CONSTRAINT "ledger_change_token_id_mcp_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_change" ADD CONSTRAINT "ledger_change_undoes_change_id_ledger_change_id_fk" FOREIGN KEY ("undoes_change_id") REFERENCES "public"."ledger_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_change" ADD CONSTRAINT "ledger_change_undone_by_change_id_ledger_change_id_fk" FOREIGN KEY ("undone_by_change_id") REFERENCES "public"."ledger_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_change_user_created_idx" ON "ledger_change" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_change_user_idempotency_uniq" ON "ledger_change" USING btree ("user_id","idempotency_key") WHERE "ledger_change"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_scope_check" CHECK ("mcp_token"."scope" in ('read', 'propose', 'write'));