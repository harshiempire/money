CREATE TABLE "assistant_context_note" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_context_note" ADD CONSTRAINT "assistant_context_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_context_note_user_idx" ON "assistant_context_note" USING btree ("user_id","created_at");