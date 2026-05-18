CREATE TABLE "person" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "split_participant" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_user_lower_name_uniq" ON "person" USING btree ("user_id",lower("name"));--> statement-breakpoint
ALTER TABLE "split_participant" ADD CONSTRAINT "split_participant_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;