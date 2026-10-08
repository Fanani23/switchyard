CREATE TYPE "public"."flag_kind" AS ENUM('boolean', 'multivariate');--> statement-breakpoint
CREATE TYPE "public"."key_scope" AS ENUM('admin', 'client');--> statement-breakpoint
CREATE TYPE "public"."rule_kind" AS ENUM('segment', 'percentage');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scope" "key_scope" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_keys_hash_length" CHECK (length("api_keys"."token_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"environment_key" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_has_a_side" CHECK ("audit_log"."before" IS NOT NULL OR "audit_log"."after" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"ruleset_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_key_format" CHECK ("environments"."key" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"kind" "flag_kind" NOT NULL,
	"default_variant" text NOT NULL,
	"salt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_key_format" CHECK ("flags"."key" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "flags_salt_not_blank" CHECK (length("flags"."salt") >= 8)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_format" CHECK ("projects"."slug" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "rule_kind" NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "rules_position_range" CHECK ("rules"."position" >= 0 AND "rules"."position" < 20),
	CONSTRAINT "rules_config_is_object" CHECK (jsonb_typeof("rules"."config") = 'object')
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "variants_position_range" CHECK ("variants"."position" >= 0 AND "variants"."position" < 10)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_flag_id_flags_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_environment_idx" ON "api_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "audit_log_environment_created_idx" ON "audit_log" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_key_uq" ON "environments" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "flags_environment_key_uq" ON "flags" USING btree ("environment_id","key");--> statement-breakpoint
CREATE INDEX "flags_environment_idx" ON "flags" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_flag_position_uq" ON "rules" USING btree ("flag_id","position");--> statement-breakpoint
CREATE INDEX "rules_flag_idx" ON "rules" USING btree ("flag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_flag_key_uq" ON "variants" USING btree ("flag_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_flag_position_uq" ON "variants" USING btree ("flag_id","position");