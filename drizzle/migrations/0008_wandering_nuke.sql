CREATE INDEX "import_account_created_idx" ON "import" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "money_account_user_bank_uniq" ON "money_account" USING btree ("user_id","bank");--> statement-breakpoint
CREATE INDEX "owed_expense_user_incurred_idx" ON "owed_expense" USING btree ("user_id","incurred_date");--> statement-breakpoint
CREATE INDEX "settlement_inflow_txn_idx" ON "settlement" USING btree ("inflow_transaction_id");--> statement-breakpoint
CREATE INDEX "settlement_split_participant_idx" ON "settlement" USING btree ("split_participant_id");--> statement-breakpoint
CREATE INDEX "settlement_owed_expense_idx" ON "settlement" USING btree ("owed_expense_id");--> statement-breakpoint
CREATE INDEX "split_participant_split_id_idx" ON "split_participant" USING btree ("split_id");--> statement-breakpoint
CREATE INDEX "split_transaction_id_idx" ON "split" USING btree ("transaction_id");