CREATE TYPE "public"."settlement_method" AS ENUM('bank', 'cash');--> statement-breakpoint
ALTER TABLE "settlement" ALTER COLUMN "inflow_transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "method" "settlement_method" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "note" text;