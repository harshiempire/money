CREATE TABLE "mcp_tag_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"token_id" text,
	"source_label" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"rows" jsonb NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "mcp_tag_draft_status_check" CHECK ("mcp_tag_draft"."status" in ('pending', 'applied', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "mcp_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"scope" text NOT NULL,
	"user_token_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_token_scope_check" CHECK ("mcp_token"."scope" in ('read', 'propose'))
);
--> statement-breakpoint
ALTER TABLE "mcp_tag_draft" ADD CONSTRAINT "mcp_tag_draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tag_draft" ADD CONSTRAINT "mcp_tag_draft_account_id_money_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tag_draft" ADD CONSTRAINT "mcp_tag_draft_token_id_mcp_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_account_id_money_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tag_draft_user_status_created_idx" ON "mcp_tag_draft" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_token_hash_uniq" ON "mcp_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_token_user_created_idx" ON "mcp_token" USING btree ("user_id","created_at");