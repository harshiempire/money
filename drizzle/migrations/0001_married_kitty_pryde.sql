DROP INDEX "txn_account_ref_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "txn_account_ref_uniq" ON "transaction" USING btree ("account_id","ref_id","dr_cr");