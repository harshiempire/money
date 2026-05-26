ALTER TYPE "public"."settlement_method" ADD VALUE 'offset';--> statement-breakpoint
CREATE TABLE "net_event" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_date" date NOT NULL,
	"inflow_transaction_id" text,
	"outflow_transaction_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owed_expense" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"person_id" text,
	"person_name" text NOT NULL,
	"incurred_date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"description" text NOT NULL,
	"category_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlement" ALTER COLUMN "split_participant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "owed_expense_id" text;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "net_event_id" text;--> statement-breakpoint
ALTER TABLE "net_event" ADD CONSTRAINT "net_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_event" ADD CONSTRAINT "net_event_inflow_transaction_id_transaction_id_fk" FOREIGN KEY ("inflow_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_event" ADD CONSTRAINT "net_event_outflow_transaction_id_transaction_id_fk" FOREIGN KEY ("outflow_transaction_id") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owed_expense" ADD CONSTRAINT "owed_expense_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owed_expense" ADD CONSTRAINT "owed_expense_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owed_expense" ADD CONSTRAINT "owed_expense_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_owed_expense_id_owed_expense_id_fk" FOREIGN KEY ("owed_expense_id") REFERENCES "public"."owed_expense"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_net_event_id_net_event_id_fk" FOREIGN KEY ("net_event_id") REFERENCES "public"."net_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_target_xor" CHECK ((
        ("settlement"."split_participant_id" IS NOT NULL AND "settlement"."owed_expense_id" IS NULL)
        OR
        ("settlement"."split_participant_id" IS NULL AND "settlement"."owed_expense_id" IS NOT NULL)
      ));