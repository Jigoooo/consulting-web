ALTER TABLE "evidence_items" ADD COLUMN "quality_score" integer;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "quality_signals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"status" text NOT NULL,
	"extractor" text,
	"text_content" text DEFAULT '' NOT NULL,
	"text_chars" integer DEFAULT 0 NOT NULL,
	"quality_score" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_attachment_id_file_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."file_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_attachment_unique" UNIQUE("attachment_id");--> statement-breakpoint
CREATE INDEX "document_extractions_thread_idx" ON "document_extractions" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_extractions_workspace_idx" ON "document_extractions" USING btree ("workspace_id");
