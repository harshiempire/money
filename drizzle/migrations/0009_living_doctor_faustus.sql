CREATE TYPE "public"."residual_disposition" AS ENUM('kept', 'written_off');--> statement-breakpoint
ALTER TYPE "public"."settlement_method" ADD VALUE 'writeoff';--> statement-breakpoint
ALTER TABLE "owed_expense" ADD COLUMN "source_inflow_transaction_id" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "residual_disposition" "residual_disposition";--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "residual_acknowledged_paise" bigint;--> statement-breakpoint
ALTER TABLE "owed_expense" ADD CONSTRAINT "owed_expense_source_inflow_transaction_id_transaction_id_fk" FOREIGN KEY ("source_inflow_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owed_expense_source_inflow_idx" ON "owed_expense" USING btree ("source_inflow_transaction_id");