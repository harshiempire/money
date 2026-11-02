ALTER TABLE "counterparty" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counterparty_user_person_idx" ON "counterparty" USING btree ("user_id","person_id");