create extension if not exists "pgjwt" with schema "extensions";
drop extension if exists "pg_net";
create type "public"."tax_doc_access_action" as enum ('uploaded', 'signed_url_issued', 'downloaded', 'viewed', 'status_changed', 'deleted');
create type "public"."tax_doc_status" as enum ('pending', 'received', 'verified', 'rejected', 'replaced');
create type "public"."tax_doc_type" as enum ('w9', 'w4');
create sequence "public"."tax_doc_access_logs_id_seq";
create table "public"."agreement_versions" (
    "version" text not null,
    "bucket" text not null default 'agreements'::text,
    "path" text not null,
    "active" boolean not null default true,
    "created_at" timestamp with time zone not null default now()
      );
create table "public"."batch_confirmations" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid,
    "item_id" uuid,
    "barcode" text,
    "confirmed_count" integer,
    "timestamp" timestamp with time zone default now(),
    "location_label" text,
    "latitude" numeric,
    "longitude" numeric
      );
create table "public"."bulk_batches" (
    "id" uuid not null default gen_random_uuid(),
    "item_type_id" uuid not null,
    "bag_barcode" text not null,
    "location_id" uuid,
    "tare_weight_g" numeric(12,4) not null,
    "gross_weight_g" numeric(12,4) not null,
    "net_weight_g" numeric(12,4) generated always as ((gross_weight_g - tare_weight_g)) stored,
    "sample_w1_g" numeric(10,4),
    "sample_w2_g" numeric(10,4),
    "sample_w3_g" numeric(10,4),
    "sample_w4_g" numeric(10,4),
    "sample_w5_g" numeric(10,4),
    "unit_override_g" numeric(10,4),
    "unit_source" text not null default 'samples'::text,
    "unit_weight_g" numeric(10,4) not null,
    "estimated_qty" integer not null,
    "residual_g" numeric(12,4) generated always as (((gross_weight_g - tare_weight_g) - ((estimated_qty)::numeric * unit_weight_g))) stored,
    "notes" text,
    "created_by" uuid not null default auth.uid(),
    "created_at" timestamp with time zone not null default now(),
    "retired_at" timestamp with time zone,
    "bag_label_url" text,
    "bag_photo_url" text
      );
alter table "public"."bulk_batches" enable row level security;
create table "public"."contractor_agreements" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "user_id" uuid not null,
    "version" text not null,
    "legal_name" text not null,
    "accepted_at" timestamp with time zone not null default now(),
    "ip" text,
    "user_agent" text
      );
create table "public"."contractor_payments" (
    "id" uuid not null default gen_random_uuid(),
    "pay_period_id" uuid not null,
    "employee_id" uuid not null,
    "payroll_run_id" uuid,
    "amount" numeric not null,
    "status" text not null default 'draft'::text,
    "method" text not null default 'unspecified'::text,
    "reference" text,
    "paid_at" timestamp with time zone,
    "paid_by" uuid,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid not null default auth.uid()
      );
alter table "public"."contractor_payments" enable row level security;
create table "public"."credit_tiers" (
    "id" text not null,
    "label" text not null,
    "emoji" text not null,
    "unit_value" numeric not null
      );
create table "public"."deletion_log" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "user_id" uuid,
    "deleted_ids" uuid[],
    "timestamp" timestamp with time zone,
    "location_lat" double precision,
    "location_lng" double precision,
    "deleted_data" jsonb
      );
create table "public"."employee_legal_addresses" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "line1" text not null,
    "line2" text,
    "city" text not null,
    "state" text not null,
    "postal_code" text not null,
    "country" text not null default 'US'::text,
    "is_current" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid default auth.uid(),
    "updated_at" timestamp with time zone not null default now()
      );
alter table "public"."employee_legal_addresses" enable row level security;
create table "public"."employee_managers" (
    "employee_id" uuid not null,
    "manager_employee_id" uuid not null
      );
alter table "public"."employee_managers" enable row level security;
create table "public"."employee_rates" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "hourly_rate" numeric not null,
    "effective_from" date not null default CURRENT_DATE,
    "effective_to" date,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid not null default auth.uid()
      );
alter table "public"."employee_rates" enable row level security;
create table "public"."employee_tax_docs" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "doc_type" public.tax_doc_type not null default 'w9'::public.tax_doc_type,
    "status" public.tax_doc_status not null default 'pending'::public.tax_doc_status,
    "storage_bucket" text not null default 'tax-dots'::text,
    "storage_path" text,
    "received_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "rejection_reason" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "is_active" boolean not null default true
      );
alter table "public"."employee_tax_docs" enable row level security;
create table "public"."employees" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid not null,
    "display_name" text not null,
    "role" text not null default 'employee'::text,
    "active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "email" text,
    "invited_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "hourly_rate" numeric(10,2),
    "worker_type" text not null default 'employee'::text,
    "agreement_version_required" text
      );
alter table "public"."employees" enable row level security;
create table "public"."favorites" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid,
    "item_id" uuid,
    "created_at" timestamp with time zone default now()
      );
create table "public"."item_stock_locations" (
    "id" uuid not null default gen_random_uuid(),
    "item_id" uuid,
    "quantity" integer not null default 0,
    "last_updated" timestamp with time zone default now(),
    "added_by" uuid,
    "confirmation_email" text,
    "confirmation_method" text,
    "confirmed_at" timestamp with time zone default now(),
    "location_id" uuid,
    "locked_by" uuid,
    "locked_at" timestamp with time zone,
    "batch_id" uuid
      );
create table "public"."item_types" (
    "id" uuid not null default gen_random_uuid(),
    "title" text not null,
    "description" text,
    "weight" numeric,
    "cost" numeric,
    "sale_price" numeric,
    "distributor_name" text,
    "distributor_phone" text,
    "distributor_notes" text,
    "barcode" text,
    "qr_code" text,
    "photo_url" text,
    "created_at" timestamp with time zone default now(),
    "dymo_label_url" text,
    "photos" text[] default '{}'::text[],
    "qr_type" text,
    "categories" text[],
    "stock" numeric default '0'::numeric,
    "stock_batch_size_update" numeric default '20'::numeric,
    "price_per_weight" numeric,
    "added_by" uuid,
    "added_by_email" text
      );
alter table "public"."item_types" enable row level security;
create table "public"."locations" (
    "id" uuid not null default gen_random_uuid(),
    "location_name" text not null,
    "location_code" text not null,
    "dymo_label_url" text,
    "photo_url" text,
    "type" text,
    "max_capacity" integer,
    "active" boolean default true,
    "notes" text,
    "created_at" timestamp without time zone default now(),
    "updated_at" timestamp without time zone default now()
      );
create table "public"."metadata" (
    "id" text not null,
    "inventory_version" text not null,
    "updated_at" timestamp with time zone default now(),
    "changed_item_ids" text[]
      );
create table "public"."metal_spot_prices" (
    "metal" text not null,
    "price_per_gram" numeric not null,
    "as_of" timestamp with time zone not null default now(),
    "source" text
      );
create table "public"."pay_periods" (
    "id" uuid not null default gen_random_uuid(),
    "start_date" date not null,
    "end_date" date not null,
    "timezone" text not null default 'America/New_York'::text,
    "status" text not null default 'open'::text,
    "locked_at" timestamp with time zone,
    "locked_by" uuid,
    "note" text,
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."pay_periods" enable row level security;
create table "public"."payroll_run_lines" (
    "id" uuid not null default gen_random_uuid(),
    "payroll_run_id" uuid not null,
    "employee_id" uuid not null,
    "paid_seconds" bigint not null default 0,
    "paid_hours" numeric not null default 0,
    "hourly_rate" numeric not null,
    "gross_pay" numeric not null default 0,
    "shift_count" integer not null default 0,
    "anomaly_count" integer not null default 0,
    "details" jsonb not null default '{}'::jsonb,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "employee_ss" numeric(12,2),
    "employee_medicare" numeric(12,2),
    "employee_fica" numeric(12,2),
    "net_before_federal" numeric(12,2),
    "fica_is_estimate" boolean default true,
    "ytd_wages" numeric,
    "ss_taxable_this_run" numeric,
    "ss_employee" numeric,
    "medicare_employee" numeric,
    "addl_medicare_employee" numeric,
    "fica_employee_total" numeric,
    "net_pre_fed" numeric,
    "fica_year" integer,
    "fica_params" jsonb
      );
alter table "public"."payroll_run_lines" enable row level security;
create table "public"."payroll_runs" (
    "id" uuid not null default gen_random_uuid(),
    "pay_period_id" uuid not null,
    "status" text not null default 'draft'::text,
    "rounding_mode" text not null default 'none'::text,
    "break_policy" text not null default 'subtract_all_breaks'::text,
    "paid_break_cap_min" integer,
    "rules" jsonb not null default '{}'::jsonb,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid not null default auth.uid(),
    "finalized_at" timestamp with time zone,
    "finalized_by" uuid
      );
alter table "public"."payroll_runs" enable row level security;
create table "public"."payroll_statements" (
    "id" uuid not null default gen_random_uuid(),
    "payroll_run_id" uuid not null,
    "pay_period_id" uuid not null,
    "employee_id" uuid not null,
    "run_status" text not null,
    "rounding_mode" text not null,
    "created_at" timestamp with time zone not null default now(),
    "hourly_rate" numeric not null default 0,
    "gross_pay" numeric not null default 0,
    "total_paid" numeric not null default 0,
    "total_due" numeric not null default 0,
    "shifts_count" integer not null default 0,
    "minutes_worked" integer not null default 0,
    "break_minutes" integer not null default 0,
    "paid_break_minutes" integer not null default 0,
    "unpaid_break_minutes" integer not null default 0,
    "paid_minutes" integer not null default 0,
    "rounded_minutes" integer not null default 0,
    "hours_paid" numeric not null default 0,
    "details" jsonb not null default '{}'::jsonb
      );
alter table "public"."payroll_statements" enable row level security;
create table "public"."payroll_tax_constants" (
    "tax_year" integer not null,
    "ss_wage_base" numeric not null,
    "addl_medicare_threshold" numeric not null default 200000
      );
create table "public"."sale_item_categories" (
    "id" uuid not null default gen_random_uuid(),
    "sale_item_id" uuid not null,
    "category" text not null
      );
create table "public"."sale_items" (
    "id" uuid not null default gen_random_uuid(),
    "sale_id" uuid not null,
    "item_id" uuid not null,
    "title" text not null,
    "quantity" integer not null,
    "sale_price" numeric(12,2) not null,
    "discount_percent" numeric(5,2) default 0,
    "discount_amount" numeric(12,2) default 0,
    "final_price" numeric(12,2) not null,
    "remaining_stock_qty" integer,
    "location_id" uuid,
    "photo_path" text,
    "created_at" timestamp with time zone default now()
      );
create table "public"."sales" (
    "id" uuid not null default gen_random_uuid(),
    "external_sales_id" text,
    "user_id" uuid,
    "email" text,
    "platform" text not null,
    "subtotal" numeric(12,2) not null,
    "credits_applied" numeric(12,2) default 0,
    "total_discount" numeric(12,2) default 0,
    "final_amount" numeric(12,2) not null,
    "platform_fee_amount" numeric(12,2) default 0,
    "platform_fee_percent" numeric(5,2) default 0,
    "profit_amount" numeric(12,2) not null,
    "flagged" boolean default false,
    "created_at" timestamp with time zone default now(),
    "verified_method" text,
    "verified_at" timestamp with time zone
      );
create table "public"."sales_audit" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "external_sales_id" text,
    "subtotal" numeric,
    "credits_applied" numeric,
    "owes_after_credit" numeric,
    "per_item_discount" numeric,
    "general_discount" numeric,
    "effective_discount_pct" numeric,
    "owes_store" numeric,
    "platform_fee_amount" numeric,
    "platform_fee_percent" numeric,
    "profit_amount" numeric,
    "platform" text,
    "cart_snapshot" jsonb,
    "flagged" boolean,
    "notes" text,
    "verified_method" text,
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone default now(),
    "email" text,
    "user_id" uuid,
    "credits_breakdown" jsonb
      );
create table "public"."sales_channels" (
    "id" text not null,
    "name" text not null,
    "active" boolean not null default true,
    "currency" text not null default 'USD'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );
create table "public"."shift_adjustments" (
    "id" uuid not null default gen_random_uuid(),
    "time_entry_id" uuid not null,
    "editor_user_id" uuid not null,
    "edited_at" timestamp with time zone not null default now(),
    "reason" text not null,
    "fields_changed" text[] not null,
    "old_value" jsonb not null,
    "new_value" jsonb not null
      );
alter table "public"."shift_adjustments" enable row level security;
create table "public"."shift_approvals" (
    "time_entry_id" uuid not null,
    "status" text not null default 'approved'::text,
    "note" text,
    "approved_by" uuid not null,
    "approved_at" timestamp with time zone not null default now()
      );
alter table "public"."shift_approvals" enable row level security;
create table "public"."sms_outbox" (
    "id" uuid not null default gen_random_uuid(),
    "to_phone" text not null,
    "body" text not null,
    "send_after" timestamp with time zone not null default now(),
    "status" text not null default 'pending'::text,
    "provider" text not null default 'twilio'::text,
    "meta" jsonb not null default '{}'::jsonb,
    "attempts" integer not null default 0,
    "last_error" text,
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."sms_outbox" enable row level security;
create table "public"."stock_transactions" (
    "id" uuid not null default gen_random_uuid(),
    "item_id" uuid not null,
    "location_id" uuid not null,
    "quantity" integer not null,
    "action_type" text not null,
    "confirmed_at" timestamp with time zone not null default now(),
    "user_id" uuid,
    "notes" text,
    "source_transaction_id" uuid,
    "method" text,
    "email" text,
    "timestamp" timestamp with time zone default now()
      );
create table "public"."store_locations" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "lat" numeric(9,6) not null,
    "lng" numeric(9,6) not null,
    "radius_m" integer not null default 50,
    "active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "timezone" text not null default 'America/New_York'::text,
    "schedule_grace_in_m" integer not null default 5,
    "schedule_grace_out_m" integer not null default 5,
    "schedule_enforce" boolean not null default false,
    "paid_break_cap_min" integer not null default 30
      );
alter table "public"."store_locations" enable row level security;
create table "public"."storefront_listings" (
    "id" uuid not null default gen_random_uuid(),
    "channel_id" text not null,
    "item_type_id" uuid not null,
    "published" boolean not null default false,
    "published_at" timestamp with time zone,
    "sort_rank" integer not null default 1000,
    "public_title" text,
    "public_description" text,
    "pricing_mode" text not null default 'fixed'::text,
    "public_price_override" numeric,
    "metal" text,
    "purity_basis_points" integer,
    "premium_basis_points" integer not null default 0,
    "labor_fee" numeric not null default 0,
    "rounding_increment" numeric not null default 1,
    "badge_flags" text[] not null default '{}'::text[],
    "public_photo_keys" text[] not null default '{}'::text[],
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );
create table "public"."tax_doc_access_logs" (
    "id" bigint not null default nextval('public.tax_doc_access_logs_id_seq'::regclass),
    "employee_tax_doc_id" uuid not null,
    "actor_user_id" uuid,
    "action" public.tax_doc_access_action not null,
    "ip" inet,
    "user_agent" text,
    "meta" jsonb,
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."tax_doc_access_logs" enable row level security;
create table "public"."time_breaks" (
    "id" uuid not null default gen_random_uuid(),
    "time_entry_id" uuid not null,
    "started_at" timestamp with time zone not null default now(),
    "ended_at" timestamp with time zone,
    "start_lat" numeric,
    "start_lng" numeric,
    "start_accuracy_m" numeric,
    "end_lat" numeric,
    "end_lng" numeric,
    "end_accuracy_m" numeric,
    "geo_ok_start" boolean,
    "geo_ok_end" boolean,
    "created_at" timestamp with time zone not null default now(),
    "photo_start_path" text,
    "photo_end_path" text,
    "break_codes" text[] not null default '{}'::text[]
      );
alter table "public"."time_breaks" enable row level security;
create table "public"."time_entries" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "clock_in" timestamp with time zone not null,
    "clock_out" timestamp with time zone,
    "clock_in_lat" numeric(9,6),
    "clock_in_lng" numeric(9,6),
    "clock_in_accuracy_m" numeric,
    "clock_in_distance_m" numeric,
    "geo_ok_in" boolean,
    "clock_out_lat" numeric(9,6),
    "clock_out_lng" numeric(9,6),
    "clock_out_accuracy_m" numeric,
    "clock_out_distance_m" numeric,
    "geo_ok_out" boolean,
    "store_id" uuid,
    "device_info" text,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "photo_in_path" text,
    "photo_out_path" text,
    "expected_start_ts" timestamp with time zone,
    "expected_end_ts" timestamp with time zone,
    "schedule_codes" text[] not null default '{}'::text[],
    "schedule_note" text
      );
alter table "public"."time_entries" enable row level security;
create table "public"."timeclock_day_exceptions" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "work_date" date not null,
    "allow_clock_in_any_store" boolean not null default false,
    "clock_in_store_id" uuid,
    "allow_clock_out_any_store" boolean not null default false,
    "clock_out_store_id" uuid,
    "note" text,
    "created_by" uuid not null default auth.uid(),
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."timeclock_day_exceptions" enable row level security;
create table "public"."timeclock_store_exceptions" (
    "id" uuid not null default gen_random_uuid(),
    "store_id" uuid not null,
    "work_date" date not null,
    "allow_clock_in_any_store" boolean not null default false,
    "clock_in_store_id" uuid,
    "allow_clock_out_any_store" boolean not null default false,
    "clock_out_store_id" uuid,
    "note" text,
    "created_by" uuid not null default auth.uid(),
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."timeclock_store_exceptions" enable row level security;
create table "public"."user_phones" (
    "user_id" uuid not null,
    "phone_e164" text not null,
    "verified_at" timestamp with time zone,
    "can_sms" boolean not null default true,
    "created_at" timestamp with time zone not null default now()
      );
alter table "public"."user_phones" enable row level security;
create table "public"."work_schedule_overrides" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "work_date" date not null,
    "store_id" uuid,
    "start_local" time without time zone,
    "end_local" time without time zone,
    "off" boolean not null default false,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid default auth.uid()
      );
alter table "public"."work_schedule_overrides" enable row level security;
create table "public"."work_schedules" (
    "id" uuid not null default gen_random_uuid(),
    "employee_id" uuid not null,
    "store_id" uuid,
    "weekday" smallint not null,
    "start_local" time without time zone not null,
    "end_local" time without time zone not null,
    "effective_from" date not null default CURRENT_DATE,
    "effective_to" date,
    "active" boolean not null default true,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "created_by" uuid default auth.uid()
      );
alter table "public"."work_schedules" enable row level security;
alter sequence "public"."tax_doc_access_logs_id_seq" owned by "public"."tax_doc_access_logs"."id";
CREATE UNIQUE INDEX agreement_versions_one_active ON public.agreement_versions USING btree (active) WHERE (active = true);
CREATE UNIQUE INDEX agreement_versions_pkey ON public.agreement_versions USING btree (version);
CREATE UNIQUE INDEX batch_confirmations_pkey ON public.batch_confirmations USING btree (id);
CREATE UNIQUE INDEX bulk_batches_bag_barcode_key ON public.bulk_batches USING btree (bag_barcode);
CREATE UNIQUE INDEX bulk_batches_pkey ON public.bulk_batches USING btree (id);
CREATE UNIQUE INDEX contractor_agreements_employee_id_version_key ON public.contractor_agreements USING btree (employee_id, version);
CREATE UNIQUE INDEX contractor_agreements_pkey ON public.contractor_agreements USING btree (id);
CREATE INDEX contractor_payments_emp_idx ON public.contractor_payments USING btree (employee_id, created_at DESC);
CREATE INDEX contractor_payments_period_idx ON public.contractor_payments USING btree (pay_period_id, created_at DESC);
CREATE UNIQUE INDEX contractor_payments_pkey ON public.contractor_payments USING btree (id);
CREATE INDEX contractor_payments_run_emp_idx ON public.contractor_payments USING btree (payroll_run_id, employee_id);
CREATE UNIQUE INDEX contractor_payments_unique_active ON public.contractor_payments USING btree (pay_period_id, employee_id) WHERE (status <> 'void'::text);
CREATE UNIQUE INDEX credit_tiers_pkey ON public.credit_tiers USING btree (id);
CREATE UNIQUE INDEX deletion_log_pkey ON public.deletion_log USING btree (id);
CREATE INDEX employee_legal_addresses_emp_created ON public.employee_legal_addresses USING btree (employee_id, created_at DESC);
CREATE UNIQUE INDEX employee_legal_addresses_one_current ON public.employee_legal_addresses USING btree (employee_id) WHERE (is_current = true);
CREATE UNIQUE INDEX employee_legal_addresses_pkey ON public.employee_legal_addresses USING btree (id);
CREATE UNIQUE INDEX employee_managers_pkey ON public.employee_managers USING btree (employee_id, manager_employee_id);
CREATE INDEX employee_rates_employee_from_idx ON public.employee_rates USING btree (employee_id, effective_from DESC);
CREATE INDEX employee_rates_employee_to_idx ON public.employee_rates USING btree (employee_id, effective_to);
CREATE UNIQUE INDEX employee_rates_pkey ON public.employee_rates USING btree (id);
CREATE UNIQUE INDEX employee_rates_unique_exact ON public.employee_rates USING btree (employee_id, effective_from, hourly_rate);
CREATE INDEX employee_tax_docs_active_idx ON public.employee_tax_docs USING btree (employee_id, is_active);
CREATE INDEX employee_tax_docs_employee_id_idx ON public.employee_tax_docs USING btree (employee_id);
CREATE UNIQUE INDEX employee_tax_docs_pkey ON public.employee_tax_docs USING btree (id);
CREATE INDEX employees_accepted_at_idx ON public.employees USING btree (accepted_at);
CREATE UNIQUE INDEX employees_email_lower_uidx ON public.employees USING btree (lower(email));
CREATE UNIQUE INDEX employees_email_unique ON public.employees USING btree (email);
CREATE INDEX employees_invited_at_idx ON public.employees USING btree (invited_at);
CREATE UNIQUE INDEX employees_pkey ON public.employees USING btree (id);
CREATE UNIQUE INDEX employees_user_id_key ON public.employees USING btree (user_id);
CREATE UNIQUE INDEX favorites_pkey ON public.favorites USING btree (id);
CREATE UNIQUE INDEX favorites_user_id_item_id_key ON public.favorites USING btree (user_id, item_id);
CREATE INDEX idx_bulk_batches_active ON public.bulk_batches USING btree (((retired_at IS NULL)));
CREATE INDEX idx_bulk_batches_created_at ON public.bulk_batches USING btree (created_at DESC);
CREATE INDEX idx_bulk_batches_item_type ON public.bulk_batches USING btree (item_type_id);
CREATE INDEX idx_bulk_batches_location ON public.bulk_batches USING btree (location_id);
CREATE INDEX idx_item_stock_locations_batch ON public.item_stock_locations USING btree (batch_id);
CREATE INDEX idx_sa_edited_at ON public.shift_adjustments USING btree (edited_at DESC);
CREATE INDEX idx_sa_editor_user ON public.shift_adjustments USING btree (editor_user_id);
CREATE INDEX idx_sa_time_entry ON public.shift_adjustments USING btree (time_entry_id);
CREATE INDEX idx_stock_transactions_item_location ON public.stock_transactions USING btree (item_id, location_id);
CREATE INDEX idx_stock_transactions_item_time ON public.stock_transactions USING btree (item_id, confirmed_at DESC);
CREATE INDEX idx_storefront_listings_channel_pub ON public.storefront_listings USING btree (channel_id, published, sort_rank);
CREATE INDEX idx_storefront_listings_item ON public.storefront_listings USING btree (item_type_id);
CREATE INDEX idx_time_entries_clock_in ON public.time_entries USING btree (clock_in);
CREATE INDEX idx_time_entries_emp_month ON public.time_entries USING btree (employee_id, clock_in) WHERE (clock_out IS NOT NULL);
CREATE INDEX idx_time_entries_employee ON public.time_entries USING btree (employee_id);
CREATE INDEX idx_ws_emp_range ON public.work_schedules USING btree (employee_id, effective_from, COALESCE(effective_to, 'infinity'::date));
CREATE INDEX idx_ws_emp_weekday ON public.work_schedules USING btree (employee_id, weekday);
CREATE INDEX idx_wso_emp_date ON public.work_schedule_overrides USING btree (employee_id, work_date);
CREATE UNIQUE INDEX item_stock_locations_pkey ON public.item_stock_locations USING btree (id);
CREATE UNIQUE INDEX items_barcode_key ON public.item_types USING btree (barcode);
CREATE UNIQUE INDEX items_pkey ON public.item_types USING btree (id);
CREATE UNIQUE INDEX locations_location_code_key ON public.locations USING btree (location_code);
CREATE UNIQUE INDEX locations_pkey ON public.locations USING btree (id);
CREATE UNIQUE INDEX metadata_pkey ON public.metadata USING btree (id);
CREATE UNIQUE INDEX metal_spot_prices_pkey ON public.metal_spot_prices USING btree (metal);
CREATE UNIQUE INDEX pay_periods_pkey ON public.pay_periods USING btree (id);
CREATE INDEX payroll_run_lines_emp_idx ON public.payroll_run_lines USING btree (employee_id, created_at DESC);
CREATE UNIQUE INDEX payroll_run_lines_pkey ON public.payroll_run_lines USING btree (id);
CREATE INDEX payroll_run_lines_run_idx ON public.payroll_run_lines USING btree (payroll_run_id);
CREATE UNIQUE INDEX payroll_run_lines_unique_emp ON public.payroll_run_lines USING btree (payroll_run_id, employee_id);
CREATE UNIQUE INDEX payroll_runs_one_final_per_period ON public.payroll_runs USING btree (pay_period_id) WHERE (status = 'final'::text);
CREATE INDEX payroll_runs_period_idx ON public.payroll_runs USING btree (pay_period_id, created_at DESC);
CREATE UNIQUE INDEX payroll_runs_pkey ON public.payroll_runs USING btree (id);
CREATE UNIQUE INDEX payroll_statements_payroll_run_id_employee_id_key ON public.payroll_statements USING btree (payroll_run_id, employee_id);
CREATE UNIQUE INDEX payroll_statements_pkey ON public.payroll_statements USING btree (id);
CREATE UNIQUE INDEX payroll_tax_constants_pkey ON public.payroll_tax_constants USING btree (tax_year);
CREATE UNIQUE INDEX sale_item_categories_pkey ON public.sale_item_categories USING btree (id);
CREATE UNIQUE INDEX sale_items_pkey ON public.sale_items USING btree (id);
CREATE UNIQUE INDEX sales_audit_pkey ON public.sales_audit USING btree (id);
CREATE UNIQUE INDEX sales_channels_pkey ON public.sales_channels USING btree (id);
CREATE UNIQUE INDEX sales_pkey ON public.sales USING btree (id);
CREATE UNIQUE INDEX shift_adjustments_pkey ON public.shift_adjustments USING btree (id);
CREATE UNIQUE INDEX shift_approvals_pkey ON public.shift_approvals USING btree (time_entry_id);
CREATE UNIQUE INDEX sms_outbox_pkey ON public.sms_outbox USING btree (id);
CREATE UNIQUE INDEX stock_transactions_pkey ON public.stock_transactions USING btree (id);
CREATE UNIQUE INDEX store_locations_pkey ON public.store_locations USING btree (id);
CREATE UNIQUE INDEX storefront_listings_channel_item_unique ON public.storefront_listings USING btree (channel_id, item_type_id);
CREATE UNIQUE INDEX storefront_listings_pkey ON public.storefront_listings USING btree (id);
CREATE INDEX tax_doc_access_logs_actor_idx ON public.tax_doc_access_logs USING btree (actor_user_id);
CREATE INDEX tax_doc_access_logs_doc_idx ON public.tax_doc_access_logs USING btree (employee_tax_doc_id);
CREATE UNIQUE INDEX tax_doc_access_logs_pkey ON public.tax_doc_access_logs USING btree (id);
CREATE UNIQUE INDEX time_breaks_pkey ON public.time_breaks USING btree (id);
CREATE UNIQUE INDEX time_entries_pkey ON public.time_entries USING btree (id);
CREATE UNIQUE INDEX timeclock_day_exceptions_pkey ON public.timeclock_day_exceptions USING btree (id);
CREATE UNIQUE INDEX timeclock_day_exceptions_unique ON public.timeclock_day_exceptions USING btree (employee_id, work_date);
CREATE UNIQUE INDEX timeclock_store_exceptions_pkey ON public.timeclock_store_exceptions USING btree (id);
CREATE UNIQUE INDEX timeclock_store_exceptions_unique ON public.timeclock_store_exceptions USING btree (store_id, work_date);
CREATE UNIQUE INDEX uq_time_breaks_open ON public.time_breaks USING btree (time_entry_id) WHERE (ended_at IS NULL);
CREATE UNIQUE INDEX uq_time_entries_open ON public.time_entries USING btree (employee_id) WHERE (clock_out IS NULL);
CREATE UNIQUE INDEX user_phones_phone_e164_key ON public.user_phones USING btree (phone_e164);
CREATE UNIQUE INDEX user_phones_pkey ON public.user_phones USING btree (user_id);
CREATE UNIQUE INDEX work_schedule_overrides_employee_id_work_date_key ON public.work_schedule_overrides USING btree (employee_id, work_date);
CREATE UNIQUE INDEX work_schedule_overrides_pkey ON public.work_schedule_overrides USING btree (id);
CREATE UNIQUE INDEX work_schedules_pkey ON public.work_schedules USING btree (id);
alter table "public"."agreement_versions" add constraint "agreement_versions_pkey" PRIMARY KEY using index "agreement_versions_pkey";
alter table "public"."batch_confirmations" add constraint "batch_confirmations_pkey" PRIMARY KEY using index "batch_confirmations_pkey";
alter table "public"."bulk_batches" add constraint "bulk_batches_pkey" PRIMARY KEY using index "bulk_batches_pkey";
alter table "public"."contractor_agreements" add constraint "contractor_agreements_pkey" PRIMARY KEY using index "contractor_agreements_pkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_pkey" PRIMARY KEY using index "contractor_payments_pkey";
alter table "public"."credit_tiers" add constraint "credit_tiers_pkey" PRIMARY KEY using index "credit_tiers_pkey";
alter table "public"."deletion_log" add constraint "deletion_log_pkey" PRIMARY KEY using index "deletion_log_pkey";
alter table "public"."employee_legal_addresses" add constraint "employee_legal_addresses_pkey" PRIMARY KEY using index "employee_legal_addresses_pkey";
alter table "public"."employee_managers" add constraint "employee_managers_pkey" PRIMARY KEY using index "employee_managers_pkey";
alter table "public"."employee_rates" add constraint "employee_rates_pkey" PRIMARY KEY using index "employee_rates_pkey";
alter table "public"."employee_tax_docs" add constraint "employee_tax_docs_pkey" PRIMARY KEY using index "employee_tax_docs_pkey";
alter table "public"."employees" add constraint "employees_pkey" PRIMARY KEY using index "employees_pkey";
alter table "public"."favorites" add constraint "favorites_pkey" PRIMARY KEY using index "favorites_pkey";
alter table "public"."item_stock_locations" add constraint "item_stock_locations_pkey" PRIMARY KEY using index "item_stock_locations_pkey";
alter table "public"."item_types" add constraint "items_pkey" PRIMARY KEY using index "items_pkey";
alter table "public"."locations" add constraint "locations_pkey" PRIMARY KEY using index "locations_pkey";
alter table "public"."metadata" add constraint "metadata_pkey" PRIMARY KEY using index "metadata_pkey";
alter table "public"."metal_spot_prices" add constraint "metal_spot_prices_pkey" PRIMARY KEY using index "metal_spot_prices_pkey";
alter table "public"."pay_periods" add constraint "pay_periods_pkey" PRIMARY KEY using index "pay_periods_pkey";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_pkey" PRIMARY KEY using index "payroll_run_lines_pkey";
alter table "public"."payroll_runs" add constraint "payroll_runs_pkey" PRIMARY KEY using index "payroll_runs_pkey";
alter table "public"."payroll_statements" add constraint "payroll_statements_pkey" PRIMARY KEY using index "payroll_statements_pkey";
alter table "public"."payroll_tax_constants" add constraint "payroll_tax_constants_pkey" PRIMARY KEY using index "payroll_tax_constants_pkey";
alter table "public"."sale_item_categories" add constraint "sale_item_categories_pkey" PRIMARY KEY using index "sale_item_categories_pkey";
alter table "public"."sale_items" add constraint "sale_items_pkey" PRIMARY KEY using index "sale_items_pkey";
alter table "public"."sales" add constraint "sales_pkey" PRIMARY KEY using index "sales_pkey";
alter table "public"."sales_audit" add constraint "sales_audit_pkey" PRIMARY KEY using index "sales_audit_pkey";
alter table "public"."sales_channels" add constraint "sales_channels_pkey" PRIMARY KEY using index "sales_channels_pkey";
alter table "public"."shift_adjustments" add constraint "shift_adjustments_pkey" PRIMARY KEY using index "shift_adjustments_pkey";
alter table "public"."shift_approvals" add constraint "shift_approvals_pkey" PRIMARY KEY using index "shift_approvals_pkey";
alter table "public"."sms_outbox" add constraint "sms_outbox_pkey" PRIMARY KEY using index "sms_outbox_pkey";
alter table "public"."stock_transactions" add constraint "stock_transactions_pkey" PRIMARY KEY using index "stock_transactions_pkey";
alter table "public"."store_locations" add constraint "store_locations_pkey" PRIMARY KEY using index "store_locations_pkey";
alter table "public"."storefront_listings" add constraint "storefront_listings_pkey" PRIMARY KEY using index "storefront_listings_pkey";
alter table "public"."tax_doc_access_logs" add constraint "tax_doc_access_logs_pkey" PRIMARY KEY using index "tax_doc_access_logs_pkey";
alter table "public"."time_breaks" add constraint "time_breaks_pkey" PRIMARY KEY using index "time_breaks_pkey";
alter table "public"."time_entries" add constraint "time_entries_pkey" PRIMARY KEY using index "time_entries_pkey";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_pkey" PRIMARY KEY using index "timeclock_day_exceptions_pkey";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_pkey" PRIMARY KEY using index "timeclock_store_exceptions_pkey";
alter table "public"."user_phones" add constraint "user_phones_pkey" PRIMARY KEY using index "user_phones_pkey";
alter table "public"."work_schedule_overrides" add constraint "work_schedule_overrides_pkey" PRIMARY KEY using index "work_schedule_overrides_pkey";
alter table "public"."work_schedules" add constraint "work_schedules_pkey" PRIMARY KEY using index "work_schedules_pkey";
alter table "public"."bulk_batches" add constraint "bulk_batches_bag_barcode_key" UNIQUE using index "bulk_batches_bag_barcode_key";
alter table "public"."bulk_batches" add constraint "bulk_batches_estimated_qty_check" CHECK ((estimated_qty >= 0)) not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_estimated_qty_check";
alter table "public"."bulk_batches" add constraint "bulk_batches_gross_weight_g_check" CHECK ((gross_weight_g > (0)::numeric)) not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_gross_weight_g_check";
alter table "public"."bulk_batches" add constraint "bulk_batches_item_type_id_fkey" FOREIGN KEY (item_type_id) REFERENCES public.item_types(id) ON DELETE CASCADE not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_item_type_id_fkey";
alter table "public"."bulk_batches" add constraint "bulk_batches_location_id_fkey" FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_location_id_fkey";
alter table "public"."bulk_batches" add constraint "bulk_batches_tare_weight_g_check" CHECK ((tare_weight_g >= (0)::numeric)) not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_tare_weight_g_check";
alter table "public"."bulk_batches" add constraint "bulk_batches_unit_source_check" CHECK ((unit_source = ANY (ARRAY['samples'::text, 'override'::text]))) not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_unit_source_check";
alter table "public"."bulk_batches" add constraint "bulk_batches_unit_weight_g_check" CHECK ((unit_weight_g > (0)::numeric)) not valid;
alter table "public"."bulk_batches" validate constraint "bulk_batches_unit_weight_g_check";
alter table "public"."contractor_agreements" add constraint "contractor_agreements_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."contractor_agreements" validate constraint "contractor_agreements_employee_id_fkey";
alter table "public"."contractor_agreements" add constraint "contractor_agreements_employee_id_version_key" UNIQUE using index "contractor_agreements_employee_id_version_key";
alter table "public"."contractor_agreements" add constraint "contractor_agreements_version_fkey" FOREIGN KEY (version) REFERENCES public.agreement_versions(version) not valid;
alter table "public"."contractor_agreements" validate constraint "contractor_agreements_version_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_amount_check" CHECK ((amount >= (0)::numeric)) not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_amount_check";
alter table "public"."contractor_payments" add constraint "contractor_payments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_created_by_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_employee_id_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_paid_by_fkey" FOREIGN KEY (paid_by) REFERENCES auth.users(id) not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_paid_by_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_pay_period_id_fkey" FOREIGN KEY (pay_period_id) REFERENCES public.pay_periods(id) ON DELETE RESTRICT not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_pay_period_id_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_payroll_run_id_fkey" FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_payroll_run_id_fkey";
alter table "public"."contractor_payments" add constraint "contractor_payments_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'paid'::text, 'void'::text]))) not valid;
alter table "public"."contractor_payments" validate constraint "contractor_payments_status_check";
alter table "public"."deletion_log" add constraint "deletion_log_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;
alter table "public"."deletion_log" validate constraint "deletion_log_user_id_fkey";
alter table "public"."employee_legal_addresses" add constraint "employee_legal_addresses_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."employee_legal_addresses" validate constraint "employee_legal_addresses_employee_id_fkey";
alter table "public"."employee_managers" add constraint "employee_managers_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."employee_managers" validate constraint "employee_managers_employee_id_fkey";
alter table "public"."employee_managers" add constraint "employee_managers_manager_employee_id_fkey" FOREIGN KEY (manager_employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."employee_managers" validate constraint "employee_managers_manager_employee_id_fkey";
alter table "public"."employee_rates" add constraint "employee_rates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;
alter table "public"."employee_rates" validate constraint "employee_rates_created_by_fkey";
alter table "public"."employee_rates" add constraint "employee_rates_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."employee_rates" validate constraint "employee_rates_employee_id_fkey";
alter table "public"."employee_rates" add constraint "employee_rates_hourly_rate_check" CHECK ((hourly_rate >= (0)::numeric)) not valid;
alter table "public"."employee_rates" validate constraint "employee_rates_hourly_rate_check";
alter table "public"."employee_rates" add constraint "employee_rates_range_chk" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))) not valid;
alter table "public"."employee_rates" validate constraint "employee_rates_range_chk";
alter table "public"."employee_tax_docs" add constraint "employee_tax_docs_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."employee_tax_docs" validate constraint "employee_tax_docs_employee_id_fkey";
alter table "public"."employees" add constraint "employees_agreement_version_required_fkey" FOREIGN KEY (agreement_version_required) REFERENCES public.agreement_versions(version) not valid;
alter table "public"."employees" validate constraint "employees_agreement_version_required_fkey";
alter table "public"."employees" add constraint "employees_email_unique" UNIQUE using index "employees_email_unique";
alter table "public"."employees" add constraint "employees_hourly_rate_nonneg" CHECK (((hourly_rate IS NULL) OR (hourly_rate >= (0)::numeric))) not valid;
alter table "public"."employees" validate constraint "employees_hourly_rate_nonneg";
alter table "public"."employees" add constraint "employees_role_check" CHECK ((role = ANY (ARRAY['admin'::text, 'manager'::text, 'employee'::text]))) not valid;
alter table "public"."employees" validate constraint "employees_role_check";
alter table "public"."employees" add constraint "employees_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;
alter table "public"."employees" validate constraint "employees_user_id_fkey";
alter table "public"."employees" add constraint "employees_user_id_key" UNIQUE using index "employees_user_id_key";
alter table "public"."employees" add constraint "employees_worker_type_check" CHECK ((worker_type = ANY (ARRAY['employee'::text, 'contractor'::text]))) not valid;
alter table "public"."employees" validate constraint "employees_worker_type_check";
alter table "public"."favorites" add constraint "favorites_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.item_types(id) ON DELETE CASCADE not valid;
alter table "public"."favorites" validate constraint "favorites_item_id_fkey";
alter table "public"."favorites" add constraint "favorites_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;
alter table "public"."favorites" validate constraint "favorites_user_id_fkey";
alter table "public"."favorites" add constraint "favorites_user_id_item_id_key" UNIQUE using index "favorites_user_id_item_id_key";
alter table "public"."item_stock_locations" add constraint "item_stock_locations_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES public.bulk_batches(id) ON DELETE SET NULL not valid;
alter table "public"."item_stock_locations" validate constraint "item_stock_locations_batch_id_fkey";
alter table "public"."item_stock_locations" add constraint "item_stock_locations_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.item_types(id) not valid;
alter table "public"."item_stock_locations" validate constraint "item_stock_locations_item_id_fkey";
alter table "public"."item_stock_locations" add constraint "item_stock_locations_location_id_fkey" FOREIGN KEY (location_id) REFERENCES public.locations(id) not valid;
alter table "public"."item_stock_locations" validate constraint "item_stock_locations_location_id_fkey";
alter table "public"."item_stock_locations" add constraint "item_stock_locations_locked_by_fkey" FOREIGN KEY (locked_by) REFERENCES auth.users(id) not valid;
alter table "public"."item_stock_locations" validate constraint "item_stock_locations_locked_by_fkey";
alter table "public"."item_types" add constraint "items_barcode_key" UNIQUE using index "items_barcode_key";
alter table "public"."locations" add constraint "locations_location_code_key" UNIQUE using index "locations_location_code_key";
alter table "public"."metal_spot_prices" add constraint "metal_spot_prices_metal_check" CHECK ((metal = ANY (ARRAY['gold'::text, 'silver'::text]))) not valid;
alter table "public"."metal_spot_prices" validate constraint "metal_spot_prices_metal_check";
alter table "public"."metal_spot_prices" add constraint "metal_spot_prices_price_per_gram_check" CHECK ((price_per_gram > (0)::numeric)) not valid;
alter table "public"."metal_spot_prices" validate constraint "metal_spot_prices_price_per_gram_check";
alter table "public"."pay_periods" add constraint "pay_periods_check" CHECK ((end_date > start_date)) not valid;
alter table "public"."pay_periods" validate constraint "pay_periods_check";
alter table "public"."pay_periods" add constraint "pay_periods_locked_by_fkey" FOREIGN KEY (locked_by) REFERENCES auth.users(id) not valid;
alter table "public"."pay_periods" validate constraint "pay_periods_locked_by_fkey";
alter table "public"."pay_periods" add constraint "pay_periods_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'locked'::text]))) not valid;
alter table "public"."pay_periods" validate constraint "pay_periods_status_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_anomaly_count_check" CHECK ((anomaly_count >= 0)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_anomaly_count_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_employee_id_fkey";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_gross_pay_check" CHECK ((gross_pay >= (0)::numeric)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_gross_pay_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_hourly_rate_check" CHECK ((hourly_rate >= (0)::numeric)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_hourly_rate_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_paid_hours_check" CHECK ((paid_hours >= (0)::numeric)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_paid_hours_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_paid_seconds_check" CHECK ((paid_seconds >= 0)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_paid_seconds_check";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_payroll_run_id_fkey" FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_payroll_run_id_fkey";
alter table "public"."payroll_run_lines" add constraint "payroll_run_lines_shift_count_check" CHECK ((shift_count >= 0)) not valid;
alter table "public"."payroll_run_lines" validate constraint "payroll_run_lines_shift_count_check";
alter table "public"."payroll_runs" add constraint "payroll_runs_break_policy_check" CHECK ((break_policy = ANY (ARRAY['subtract_all_breaks'::text, 'paid_cap_per_day'::text]))) not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_break_policy_check";
alter table "public"."payroll_runs" add constraint "payroll_runs_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_created_by_fkey";
alter table "public"."payroll_runs" add constraint "payroll_runs_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id) not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_finalized_by_fkey";
alter table "public"."payroll_runs" add constraint "payroll_runs_pay_period_id_fkey" FOREIGN KEY (pay_period_id) REFERENCES public.pay_periods(id) ON DELETE CASCADE not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_pay_period_id_fkey";
alter table "public"."payroll_runs" add constraint "payroll_runs_rounding_mode_check" CHECK ((rounding_mode = ANY (ARRAY['none'::text, 'nearest_minute'::text, 'nearest_5'::text, 'nearest_15'::text]))) not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_rounding_mode_check";
alter table "public"."payroll_runs" add constraint "payroll_runs_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'final'::text, 'void'::text]))) not valid;
alter table "public"."payroll_runs" validate constraint "payroll_runs_status_check";
alter table "public"."payroll_statements" add constraint "payroll_statements_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."payroll_statements" validate constraint "payroll_statements_employee_id_fkey";
alter table "public"."payroll_statements" add constraint "payroll_statements_pay_period_id_fkey" FOREIGN KEY (pay_period_id) REFERENCES public.pay_periods(id) ON DELETE CASCADE not valid;
alter table "public"."payroll_statements" validate constraint "payroll_statements_pay_period_id_fkey";
alter table "public"."payroll_statements" add constraint "payroll_statements_payroll_run_id_employee_id_key" UNIQUE using index "payroll_statements_payroll_run_id_employee_id_key";
alter table "public"."payroll_statements" add constraint "payroll_statements_payroll_run_id_fkey" FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE not valid;
alter table "public"."payroll_statements" validate constraint "payroll_statements_payroll_run_id_fkey";
alter table "public"."sale_item_categories" add constraint "sale_item_categories_sale_item_id_fkey" FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON DELETE CASCADE not valid;
alter table "public"."sale_item_categories" validate constraint "sale_item_categories_sale_item_id_fkey";
alter table "public"."sale_items" add constraint "sale_items_quantity_check" CHECK ((quantity > 0)) not valid;
alter table "public"."sale_items" validate constraint "sale_items_quantity_check";
alter table "public"."sale_items" add constraint "sale_items_sale_id_fkey" FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE not valid;
alter table "public"."sale_items" validate constraint "sale_items_sale_id_fkey";
alter table "public"."sales" add constraint "sales_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;
alter table "public"."sales" validate constraint "sales_user_id_fkey";
alter table "public"."shift_adjustments" add constraint "shift_adjustments_editor_user_id_fkey" FOREIGN KEY (editor_user_id) REFERENCES auth.users(id) not valid;
alter table "public"."shift_adjustments" validate constraint "shift_adjustments_editor_user_id_fkey";
alter table "public"."shift_adjustments" add constraint "shift_adjustments_reason_check" CHECK ((length(TRIM(BOTH FROM reason)) >= 3)) not valid;
alter table "public"."shift_adjustments" validate constraint "shift_adjustments_reason_check";
alter table "public"."shift_adjustments" add constraint "shift_adjustments_time_entry_id_fkey" FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE CASCADE not valid;
alter table "public"."shift_adjustments" validate constraint "shift_adjustments_time_entry_id_fkey";
alter table "public"."shift_approvals" add constraint "shift_approvals_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES auth.users(id) not valid;
alter table "public"."shift_approvals" validate constraint "shift_approvals_approved_by_fkey";
alter table "public"."shift_approvals" add constraint "shift_approvals_status_check" CHECK ((status = ANY (ARRAY['approved'::text, 'waived'::text]))) not valid;
alter table "public"."shift_approvals" validate constraint "shift_approvals_status_check";
alter table "public"."shift_approvals" add constraint "shift_approvals_time_entry_id_fkey" FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE CASCADE not valid;
alter table "public"."shift_approvals" validate constraint "shift_approvals_time_entry_id_fkey";
alter table "public"."sms_outbox" add constraint "sms_outbox_body_check" CHECK (((length(body) > 0) AND (length(body) <= 480))) not valid;
alter table "public"."sms_outbox" validate constraint "sms_outbox_body_check";
alter table "public"."sms_outbox" add constraint "sms_outbox_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text]))) not valid;
alter table "public"."sms_outbox" validate constraint "sms_outbox_status_check";
alter table "public"."sms_outbox" add constraint "sms_outbox_to_phone_check" CHECK ((to_phone ~ '^\+\d{7,15}$'::text)) not valid;
alter table "public"."sms_outbox" validate constraint "sms_outbox_to_phone_check";
alter table "public"."stock_transactions" add constraint "stock_transactions_action_type_check" CHECK ((action_type = ANY (ARRAY['checkin'::text, 'checkout'::text, 'correction'::text, 'transfer'::text]))) not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_action_type_check";
alter table "public"."stock_transactions" add constraint "stock_transactions_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.item_types(id) ON DELETE CASCADE not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_item_id_fkey";
alter table "public"."stock_transactions" add constraint "stock_transactions_location_id_fkey" FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_location_id_fkey";
alter table "public"."stock_transactions" add constraint "stock_transactions_quantity_check" CHECK ((quantity <> 0)) not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_quantity_check";
alter table "public"."stock_transactions" add constraint "stock_transactions_source_transaction_id_fkey" FOREIGN KEY (source_transaction_id) REFERENCES public.stock_transactions(id) ON DELETE SET NULL not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_source_transaction_id_fkey";
alter table "public"."stock_transactions" add constraint "stock_transactions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL not valid;
alter table "public"."stock_transactions" validate constraint "stock_transactions_user_id_fkey";
alter table "public"."storefront_listings" add constraint "storefront_listings_channel_id_fkey" FOREIGN KEY (channel_id) REFERENCES public.sales_channels(id) ON DELETE CASCADE not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_channel_id_fkey";
alter table "public"."storefront_listings" add constraint "storefront_listings_channel_item_unique" UNIQUE using index "storefront_listings_channel_item_unique";
alter table "public"."storefront_listings" add constraint "storefront_listings_item_type_id_fkey" FOREIGN KEY (item_type_id) REFERENCES public.item_types(id) ON DELETE CASCADE not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_item_type_id_fkey";
alter table "public"."storefront_listings" add constraint "storefront_listings_metal_check" CHECK ((metal = ANY (ARRAY['gold'::text, 'silver'::text]))) not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_metal_check";
alter table "public"."storefront_listings" add constraint "storefront_listings_premium_basis_points_check" CHECK (((premium_basis_points >= 0) AND (premium_basis_points <= 10000))) not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_premium_basis_points_check";
alter table "public"."storefront_listings" add constraint "storefront_listings_pricing_mode_check" CHECK ((pricing_mode = ANY (ARRAY['fixed'::text, 'metal_spot'::text]))) not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_pricing_mode_check";
alter table "public"."storefront_listings" add constraint "storefront_listings_purity_basis_points_check" CHECK (((purity_basis_points >= 0) AND (purity_basis_points <= 10000))) not valid;
alter table "public"."storefront_listings" validate constraint "storefront_listings_purity_basis_points_check";
alter table "public"."tax_doc_access_logs" add constraint "tax_doc_access_logs_employee_tax_doc_id_fkey" FOREIGN KEY (employee_tax_doc_id) REFERENCES public.employee_tax_docs(id) ON DELETE CASCADE not valid;
alter table "public"."tax_doc_access_logs" validate constraint "tax_doc_access_logs_employee_tax_doc_id_fkey";
alter table "public"."time_breaks" add constraint "time_breaks_time_entry_id_fkey" FOREIGN KEY (time_entry_id) REFERENCES public.time_entries(id) ON DELETE CASCADE not valid;
alter table "public"."time_breaks" validate constraint "time_breaks_time_entry_id_fkey";
alter table "public"."time_entries" add constraint "time_entries_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."time_entries" validate constraint "time_entries_employee_id_fkey";
alter table "public"."time_entries" add constraint "time_entries_store_id_fkey" FOREIGN KEY (store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."time_entries" validate constraint "time_entries_store_id_fkey";
alter table "public"."time_entries" add constraint "time_order_ok" CHECK (((clock_out IS NULL) OR (clock_out >= clock_in))) not valid;
alter table "public"."time_entries" validate constraint "time_order_ok";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_clock_in_store_id_fkey" FOREIGN KEY (clock_in_store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_clock_in_store_id_fkey";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_clock_out_store_id_fkey" FOREIGN KEY (clock_out_store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_clock_out_store_id_fkey";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_created_by_fkey";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_employee_id_fkey";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_in_check" CHECK ((NOT (allow_clock_in_any_store AND (clock_in_store_id IS NOT NULL)))) not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_in_check";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_out_check" CHECK ((NOT (allow_clock_out_any_store AND (clock_out_store_id IS NOT NULL)))) not valid;
alter table "public"."timeclock_day_exceptions" validate constraint "timeclock_day_exceptions_out_check";
alter table "public"."timeclock_day_exceptions" add constraint "timeclock_day_exceptions_unique" UNIQUE using index "timeclock_day_exceptions_unique";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_clock_in_store_id_fkey" FOREIGN KEY (clock_in_store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_clock_in_store_id_fkey";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_clock_out_store_id_fkey" FOREIGN KEY (clock_out_store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_clock_out_store_id_fkey";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_created_by_fkey";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_in_check" CHECK ((NOT (allow_clock_in_any_store AND (clock_in_store_id IS NOT NULL)))) not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_in_check";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_out_check" CHECK ((NOT (allow_clock_out_any_store AND (clock_out_store_id IS NOT NULL)))) not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_out_check";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_store_id_fkey" FOREIGN KEY (store_id) REFERENCES public.store_locations(id) ON DELETE CASCADE not valid;
alter table "public"."timeclock_store_exceptions" validate constraint "timeclock_store_exceptions_store_id_fkey";
alter table "public"."timeclock_store_exceptions" add constraint "timeclock_store_exceptions_unique" UNIQUE using index "timeclock_store_exceptions_unique";
alter table "public"."user_phones" add constraint "user_phones_phone_e164_check" CHECK ((phone_e164 ~ '^\+\d{7,15}$'::text)) not valid;
alter table "public"."user_phones" validate constraint "user_phones_phone_e164_check";
alter table "public"."user_phones" add constraint "user_phones_phone_e164_key" UNIQUE using index "user_phones_phone_e164_key";
alter table "public"."user_phones" add constraint "user_phones_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;
alter table "public"."user_phones" validate constraint "user_phones_user_id_fkey";
alter table "public"."work_schedule_overrides" add constraint "work_schedule_overrides_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."work_schedule_overrides" validate constraint "work_schedule_overrides_employee_id_fkey";
alter table "public"."work_schedule_overrides" add constraint "work_schedule_overrides_employee_id_work_date_key" UNIQUE using index "work_schedule_overrides_employee_id_work_date_key";
alter table "public"."work_schedule_overrides" add constraint "work_schedule_overrides_store_id_fkey" FOREIGN KEY (store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."work_schedule_overrides" validate constraint "work_schedule_overrides_store_id_fkey";
alter table "public"."work_schedules" add constraint "work_schedules_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE not valid;
alter table "public"."work_schedules" validate constraint "work_schedules_employee_id_fkey";
alter table "public"."work_schedules" add constraint "work_schedules_store_id_fkey" FOREIGN KEY (store_id) REFERENCES public.store_locations(id) not valid;
alter table "public"."work_schedules" validate constraint "work_schedules_store_id_fkey";
alter table "public"."work_schedules" add constraint "work_schedules_weekday_check" CHECK (((weekday >= 0) AND (weekday <= 6))) not valid;
alter table "public"."work_schedules" validate constraint "work_schedules_weekday_check";
set check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.admin_get_employee_exception_history(_employee_id uuid, _limit integer DEFAULT 50)
 RETURNS TABLE(time_entry_id uuid, work_date date, clock_in timestamp with time zone, note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_role text;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'Not authenticated'; end if;

  select e.role into v_role
  from public.employees e
  where e.user_id = v_user;

  if coalesce(v_role,'') not in ('admin','manager') then
    raise exception 'Not authorized';
  end if;

  return query
  select
    sa.time_entry_id,
    (te.clock_in at time zone 'America/New_York')::date as work_date,
    te.clock_in,
    sa.note
  from public.shift_approvals sa
  join public.time_entries te on te.id = sa.time_entry_id
  where te.employee_id = _employee_id
    and sa.status = 'waived'
  order by te.clock_in desc
  limit greatest(1, least(coalesce(_limit, 50), 200));
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_get_monthly_exception_counts(_month_start date)
 RETURNS TABLE(employee_id uuid, waived_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_role text;
  v_start date;
  v_end date;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'Not authenticated'; end if;

  select e.role into v_role
  from public.employees e
  where e.user_id = v_user;

  if coalesce(v_role,'') not in ('admin','manager') then
    raise exception 'Not authorized';
  end if;

  v_start := _month_start;
  v_end := (_month_start + interval '1 month')::date;

  return query
  select
    te.employee_id,
    count(*)::int as waived_count
  from public.shift_approvals sa
  join public.time_entries te on te.id = sa.time_entry_id
  where sa.status = 'waived'
    and te.clock_in >= v_start
    and te.clock_in <  v_end
  group by te.employee_id;
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_set_employee_rate(_employee_id uuid, _hourly_rate numeric, _effective_from date, _note text DEFAULT NULL::text)
 RETURNS public.employee_rates
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prev public.employee_rates;
  v_new  public.employee_rates;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  if _employee_id is null then
    raise exception 'employee_id required' using errcode='22023';
  end if;

  if _hourly_rate is null or _hourly_rate < 0 then
    raise exception 'hourly_rate must be >= 0' using errcode='22023';
  end if;

  if _effective_from is null then
    raise exception 'effective_from required' using errcode='22023';
  end if;

  -- Find the currently-active rate row that overlaps effective_from
  select *
  into v_prev
  from public.employee_rates r
  where r.employee_id = _employee_id
    and r.effective_from <= _effective_from
    and (r.effective_to is null or r.effective_to >= _effective_from)
  order by r.effective_from desc, r.created_at desc
  limit 1;

  -- If there is an overlapping row, we "close" it the day before the new one starts
  if v_prev.id is not null then
    if v_prev.effective_from = _effective_from and v_prev.hourly_rate = _hourly_rate then
      -- exact same rate at same start date already exists: just return it
      return v_prev;
    end if;

    update public.employee_rates
    set effective_to = _effective_from - 1
    where id = v_prev.id;
  end if;

  -- Prevent starting a new rate inside another future rate block
  if exists (
    select 1
    from public.employee_rates r
    where r.employee_id = _employee_id
      and r.effective_from > _effective_from
      and r.effective_from <= _effective_from -- (no-op but keeps intent clear)
  ) then
    -- nothing; kept for clarity
  end if;

  -- Also block if there is a future rate that starts ON the same day
  if exists (
    select 1
    from public.employee_rates r
    where r.employee_id = _employee_id
      and r.effective_from = _effective_from
  ) then
    raise exception 'A rate already starts on % for this employee', _effective_from using errcode='22023';
  end if;

  insert into public.employee_rates(employee_id, hourly_rate, effective_from, effective_to, note)
  values (_employee_id, _hourly_rate, _effective_from, null, _note)
  returning * into v_new;

  return v_new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.admin_set_override(_employee_id uuid, _work_date date, _off boolean, _start_local time without time zone DEFAULT NULL::time without time zone, _end_local time without time zone DEFAULT NULL::time without time zone, _store_id uuid DEFAULT NULL::uuid, _note text DEFAULT NULL::text)
 RETURNS public.work_schedule_overrides
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.work_schedule_overrides;
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode='42501'; end if;

  insert into public.work_schedule_overrides(employee_id, work_date, off, start_local, end_local, store_id, note)
  values (_employee_id, _work_date, _off, _start_local, _end_local, _store_id, _note)
  on conflict (employee_id, work_date) do update
    set off = excluded.off,
        start_local = excluded.start_local,
        end_local = excluded.end_local,
        store_id = excluded.store_id,
        note = excluded.note
  returning * into v_row;

  return v_row;
end; $function$;
CREATE OR REPLACE FUNCTION public.admin_set_weekday_slot(_employee_id uuid, _weekday smallint, _start_local time without time zone, _end_local time without time zone, _effective_from date DEFAULT CURRENT_DATE, _effective_to date DEFAULT NULL::date, _store_id uuid DEFAULT NULL::uuid, _note text DEFAULT NULL::text)
 RETURNS public.work_schedules
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.work_schedules;
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode='42501'; end if;

  insert into public.work_schedules(employee_id, weekday, start_local, end_local, effective_from, effective_to, store_id, note, active)
  values (_employee_id, _weekday, _start_local, _end_local, _effective_from, _effective_to, _store_id, _note, true)
  returning * into v_row;

  return v_row;
end; $function$;
CREATE OR REPLACE FUNCTION public.admin_update_shift_time(_time_entry_id uuid, _new_clock_in timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_clock_out timestamp with time zone DEFAULT NULL::timestamp with time zone, _reason text DEFAULT NULL::text)
 RETURNS public.time_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row_before  public.time_entries;
  v_row_after   public.time_entries;
  v_emp_id      uuid;
  v_new_in      timestamptz;
  v_new_out     timestamptz;
  v_changed     text[] := '{}';
  v_max_hours   interval := interval '16 hours';
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  select * into v_row_before
  from public.time_entries
  where id = _time_entry_id
  for update;

  if v_row_before.id is null then
    raise exception 'Shift not found' using errcode='22023';
  end if;

  if v_row_before.clock_out is null then
    raise exception 'Cannot edit an open shift' using errcode='22023';
  end if;

  -- BLOCK edits if the EXISTING range overlaps a locked pay period
  perform public.assert_unlocked_for_range(
    v_row_before.clock_in,
    v_row_before.clock_out,
    'edit existing shift'
  );

  v_emp_id := v_row_before.employee_id;
  v_new_in  := coalesce(_new_clock_in,  v_row_before.clock_in);
  v_new_out := coalesce(_new_clock_out, v_row_before.clock_out);

  if v_new_out < v_new_in then
    raise exception 'clock_out must be >= clock_in' using errcode='22023';
  end if;

  if (v_new_out - v_new_in) > v_max_hours then
    raise exception 'Edited shift exceeds % hours', extract(hour from v_max_hours)
      using errcode='22023';
  end if;

  -- BLOCK edits if the NEW range overlaps a locked pay period
  perform public.assert_unlocked_for_range(v_new_in, v_new_out, 'edit new shift range');

  if exists (
    select 1
    from public.time_entries t
    where t.employee_id = v_emp_id
      and t.id <> v_row_before.id
      and t.clock_out is not null
      and v_new_in  < t.clock_out
      and v_new_out > t.clock_in
  ) then
    raise exception 'Edited time range overlaps another shift for this employee'
      using errcode='22023';
  end if;

  if v_new_in  is distinct from v_row_before.clock_in  then
    v_changed := array_append(v_changed, 'clock_in');
  end if;

  if v_new_out is distinct from v_row_before.clock_out then
    v_changed := array_append(v_changed, 'clock_out');
  end if;

  if coalesce(trim(_reason), '') = '' then
    raise exception 'Reason is required (min 3 characters)' using errcode='22023';
  end if;

  if array_length(v_changed,1) is null then
    return v_row_before;
  end if;

  update public.time_entries
  set clock_in  = v_new_in,
      clock_out = v_new_out
  where id = v_row_before.id
  returning * into v_row_after;

  -- Invalidate prior approval (must re-approve)
  delete from public.shift_approvals where time_entry_id = v_row_before.id;

  insert into public.shift_adjustments (
    time_entry_id, editor_user_id, reason, fields_changed, old_value, new_value
  ) values (
    v_row_after.id, auth.uid(), _reason, v_changed,
    jsonb_build_object('clock_in', v_row_before.clock_in, 'clock_out', v_row_before.clock_out),
    jsonb_build_object('clock_in', v_row_after.clock_in,  'clock_out', v_row_after.clock_out)
  );

  -- keep your existing rollups
  perform public.refresh_monthly_hours_all();

  return v_row_after;
end;
$function$;
CREATE OR REPLACE FUNCTION public.apply_fica_deductions_to_run(_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_year int;
  v_ss_wage_base numeric;
  v_addl_threshold numeric := 200000;
begin
  /*
    Computes employee-side FICA estimates for EMPLOYEES only.
    Contractors are left as NULL/0 for withholding columns.

    Assumptions:
    - YTD is based on FINALIZED payroll runs in the SAME calendar year,
      with pay period end_date < this run’s pay period end_date.
    - This is an estimate for “net pre-federal-income-tax”.
  */

  -- Determine tax year from this run’s pay period end_date
  select extract(year from pp.end_date)::int
    into v_year
  from public.payroll_runs r
  join public.pay_periods pp on pp.id = r.pay_period_id
  where r.id = _run_id;

  if v_year is null then
    raise exception 'apply_fica_deductions_to_run: run not found (%)', _run_id;
  end if;

  -- Load constants (fallback if missing)
  select c.ss_wage_base, c.addl_medicare_threshold
    into v_ss_wage_base, v_addl_threshold
  from public.payroll_tax_constants c
  where c.tax_year = v_year;

  -- If you don’t have the constants row, fallback to a sane default.
  if v_ss_wage_base is null then
    v_ss_wage_base := 184500; -- 2026 wage base (adjust if needed)
    v_addl_threshold := 200000;
  end if;

  with this_run as (
    select
      l.id as line_id,
      l.employee_id,
      coalesce(l.gross_pay, 0)::numeric as gross_pay
    from public.payroll_run_lines l
    where l.payroll_run_id = _run_id
  ),
  run_period as (
    select
      r.id as run_id,
      pp.start_date,
      pp.end_date
    from public.payroll_runs r
    join public.pay_periods pp on pp.id = r.pay_period_id
    where r.id = _run_id
  ),
  -- YTD wages prior to this run (same year), from FINALIZED runs only
  ytd as (
    select
      l.employee_id,
      coalesce(sum(l.gross_pay), 0)::numeric as ytd_wages
    from public.payroll_run_lines l
    join public.payroll_runs r2 on r2.id = l.payroll_run_id
    join public.pay_periods pp2 on pp2.id = r2.pay_period_id
    cross join run_period rp
    where r2.status = 'final'
      and extract(year from pp2.end_date)::int = v_year
      and pp2.end_date < rp.end_date
    group by l.employee_id
  ),
  emp as (
    select id, lower(coalesce(worker_type, 'employee')) as worker_type
    from public.employees
  ),
  calc as (
    select
      tr.line_id,
      tr.employee_id,
      tr.gross_pay,
      coalesce(y.ytd_wages, 0)::numeric as ytd_wages,

      -- Social Security taxable wages THIS RUN (cap applies)
      greatest(
        0,
        least(tr.gross_pay, v_ss_wage_base - coalesce(y.ytd_wages, 0))
      )::numeric as ss_taxable_this_run,

      -- Medicare taxable wages THIS RUN (no cap)
      tr.gross_pay::numeric as medicare_taxable_this_run,

      -- Additional Medicare taxable wages THIS RUN:
      -- Applies to wages above threshold, based on YTD + current wages
      greatest(
        0,
        (coalesce(y.ytd_wages, 0) + tr.gross_pay) - v_addl_threshold
      )::numeric as addl_medicare_taxable_to_date,

      greatest(
        0,
        -- portion of THIS RUN that pushes above threshold
        greatest(0, (coalesce(y.ytd_wages, 0) + tr.gross_pay) - v_addl_threshold)
        - greatest(0, (coalesce(y.ytd_wages, 0)) - v_addl_threshold)
      )::numeric as addl_medicare_taxable_this_run
    from this_run tr
    left join ytd y on y.employee_id = tr.employee_id
  )
  update public.payroll_run_lines l
  set
    fica_year = v_year,
    ytd_wages = c.ytd_wages,
    ss_taxable_this_run = c.ss_taxable_this_run,

    -- Only apply withholding math for employees
    ss_employee = case
      when e.worker_type = 'employee' then round(c.ss_taxable_this_run * 0.062, 2)
      else 0
    end,

    medicare_employee = case
      when e.worker_type = 'employee' then round(c.medicare_taxable_this_run * 0.0145, 2)
      else 0
    end,

    addl_medicare_employee = case
      when e.worker_type = 'employee' then round(c.addl_medicare_taxable_this_run * 0.009, 2)
      else 0
    end,

    fica_employee_total = case
      when e.worker_type = 'employee' then
        round(
          (c.ss_taxable_this_run * 0.062)
          + (c.medicare_taxable_this_run * 0.0145)
          + (c.addl_medicare_taxable_this_run * 0.009)
        , 2)
      else 0
    end,

    net_pre_fed = case
      when e.worker_type = 'employee' then
        round(c.gross_pay - (
          (c.ss_taxable_this_run * 0.062)
          + (c.medicare_taxable_this_run * 0.0145)
          + (c.addl_medicare_taxable_this_run * 0.009)
        ), 2)
      else
        c.gross_pay
    end,

    fica_params = jsonb_build_object(
      'ss_wage_base', v_ss_wage_base,
      'addl_medicare_threshold', v_addl_threshold,
      'rates', jsonb_build_object(
        'ss_employee', 0.062,
        'medicare_employee', 0.0145,
        'addl_medicare', 0.009
      )
    )
  from calc c
  join emp e on e.id = c.employee_id
  where l.id = c.line_id;

end;
$function$;
CREATE OR REPLACE FUNCTION public.approve_shift(_time_entry_id uuid, _status text DEFAULT 'approved'::text, _note text DEFAULT NULL::text)
 RETURNS public.shift_approvals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.shift_approvals; v int;
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode='42501'; end if;
  if coalesce(_status,'') not in ('approved','waived') then raise exception 'Invalid status' using errcode='22023'; end if;

  select count(*) into v from public.time_entries t where t.id=_time_entry_id and t.clock_out is not null;
  if v = 0 then raise exception 'Shift not found or still open' using errcode='22023'; end if;

  insert into public.shift_approvals (time_entry_id, status, note, approved_by, approved_at)
  values (_time_entry_id, _status, _note, auth.uid(), now())
  on conflict (time_entry_id) do update
    set status = excluded.status,
        note   = excluded.note,
        approved_by = auth.uid(),
        approved_at = now()
  returning * into r;

  return r;
end $function$;
CREATE OR REPLACE FUNCTION public.assert_unlocked_for_range(_start_ts timestamp with time zone, _end_ts timestamp with time zone, _context text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  if public.range_overlaps_locked_period(_start_ts, _end_ts) then
    raise exception 'Pay period is locked (%).', coalesce(_context, 'operation not allowed')
      using errcode = '22023';
  end if;
end;
$function$;
CREATE OR REPLACE FUNCTION public.assert_unlocked_for_ts(_ts timestamp with time zone, _context text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  if public.ts_overlaps_locked_period(_ts) then
    raise exception 'Pay period is locked (%).', coalesce(_context, 'operation not allowed')
      using errcode = '22023';
  end if;
end;
$function$;
CREATE OR REPLACE FUNCTION public.attach_break_photo(_break_id uuid, _phase text, _photo_path text)
 RETURNS public.time_breaks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp_user uuid;
  v_row public.time_breaks;
begin
  if _phase not in ('start','end') then
    raise exception 'Invalid phase (use start|end)' using errcode='22023';
  end if;

  -- Make sure caller owns the break or is admin
  select e.user_id
  into v_emp_user
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  join public.employees   e on e.id = t.employee_id
  where b.id = _break_id;

  if v_emp_user is null then
    raise exception 'Break not found' using errcode='22023';
  end if;

  if v_emp_user <> auth.uid() and not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  if _phase = 'start' then
    update public.time_breaks
      set photo_start_path = _photo_path
      where id = _break_id
      returning * into v_row;
  else
    update public.time_breaks
      set photo_end_path = _photo_path
      where id = _break_id
      returning * into v_row;
  end if;

  return v_row;
end;
$function$;
CREATE OR REPLACE FUNCTION public.attach_punch_photo(_entry_id uuid, _kind text, _photo_path text)
 RETURNS public.time_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.time_entries;  -- the punch row
  v_emp_user uuid;            -- auth.users.id linked to the punch's employee
  v_expected_prefix text;
begin
  -- Load the punch row
  select *
  into v_row
  from public.time_entries
  where id = _entry_id;

  if v_row.id is null then
    raise exception 'Entry not found';
  end if;

  -- Get the owning user's id for auth check
  select e.user_id
  into v_emp_user
  from public.employees e
  where e.id = v_row.employee_id;

  if v_emp_user is null then
    raise exception 'Employee not found for this entry';
  end if;

  -- Caller must own this entry or be admin
  if v_emp_user <> auth.uid() and not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  -- Validate kind
  if _kind not in ('in','out') then
    raise exception 'Invalid kind (must be ''in'' or ''out'')';
  end if;

  -- Validate path: must start with {employee_id}/
  v_expected_prefix := v_row.employee_id::text || '/';
  if position(v_expected_prefix in _photo_path) <> 1 then
    raise exception 'Photo path must start with %', v_expected_prefix;
  end if;

  -- Validate filename contains entry id and suffix
  if _kind = 'in' and _photo_path not like '%' || v_row.id::text || '_in.%' then
    raise exception 'Photo path must contain entry id and _in suffix';
  end if;
  if _kind = 'out' and _photo_path not like '%' || v_row.id::text || '_out.%' then
    raise exception 'Photo path must contain entry id and _out suffix';
  end if;

  -- Only allow first attach (no overwrite)
  if _kind = 'in' and v_row.photo_in_path is not null then
    raise exception 'Photo-in already attached';
  end if;
  if _kind = 'out' and v_row.photo_out_path is not null then
    raise exception 'Photo-out already attached';
  end if;

  -- Save path
  update public.time_entries
  set photo_in_path  = case when _kind = 'in'  then _photo_path else photo_in_path  end,
      photo_out_path = case when _kind = 'out' then _photo_path else photo_out_path end
  where id = v_row.id
  returning * into v_row;

  return v_row;
end; $function$;
CREATE OR REPLACE FUNCTION public.build_payroll_run_lines(_payroll_run_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.payroll_runs;
  v_p   public.pay_periods;
  v_rows int := 0;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id
  for update;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode='22023';
  end if;

  if v_run.status <> 'draft' then
    raise exception 'Can only build lines for a draft run' using errcode='22023';
  end if;

  select * into v_p
  from public.pay_periods
  where id = v_run.pay_period_id;

  if v_p.id is null then
    raise exception 'Pay period missing for run' using errcode='22023';
  end if;

  -- Rebuild lines idempotently (delete then insert)
  delete from public.payroll_run_lines where payroll_run_id = v_run.id;

  with shifts as (
    select
      t.id as time_entry_id,
      t.employee_id,
      t.store_id,
      t.clock_in,
      t.clock_out,
      coalesce(s.timezone, v_p.timezone) as store_tz,
      public.ts_local_date(t.clock_in, coalesce(s.timezone, v_p.timezone)) as work_date_local,
      extract(epoch from (t.clock_out - t.clock_in))::bigint as shift_seconds
    from public.time_entries t
    join public.shift_approvals sa on sa.time_entry_id = t.id
    left join public.store_locations s on s.id = t.store_id
    where t.clock_out is not null
      and public.ts_local_date(t.clock_in, coalesce(s.timezone, v_p.timezone))
          between v_p.start_date and v_p.end_date
  ),
  breaks_by_day as (
    select
      sh.employee_id,
      sh.store_id,
      sh.work_date_local,
      coalesce(sum(extract(epoch from (b.ended_at - b.started_at)))::bigint, 0) as break_seconds
    from shifts sh
    left join public.time_breaks b
      on b.time_entry_id = sh.time_entry_id
     and b.ended_at is not null
    group by sh.employee_id, sh.store_id, sh.work_date_local
  ),
  unpaid_over_cap_by_day as (
    select
      bd.employee_id,
      bd.store_id,
      bd.work_date_local,
      bd.break_seconds,
      greatest(
        bd.break_seconds - (coalesce(sl.paid_break_cap_min, 30) * 60),
        0
      ) as unpaid_break_seconds,
      coalesce(sl.paid_break_cap_min, 30) as cap_min
    from breaks_by_day bd
    left join public.store_locations sl on sl.id = bd.store_id
  ),
  per_employee_day as (
    select
      sh.employee_id,
      sh.work_date_local,
      sum(sh.shift_seconds)::bigint as worked_seconds_day,
      coalesce(max(uc.unpaid_break_seconds),0)::bigint as unpaid_break_seconds_day,
      coalesce(max(uc.break_seconds),0)::bigint as break_seconds_day,
      coalesce(max(uc.cap_min),30)::int as cap_min,
      count(*)::int as shift_count_day,
      sum(
        case when array_length(coalesce(te.schedule_codes,'{}'::text[]),1) is null then 0 else 1 end
      )::int as anomaly_count_day,
      public.resolve_hourly_rate(sh.employee_id, sh.work_date_local) as hourly_rate_day
    from shifts sh
    join public.time_entries te on te.id = sh.time_entry_id
    left join unpaid_over_cap_by_day uc
      on uc.employee_id = sh.employee_id
     and uc.store_id = sh.store_id
     and uc.work_date_local = sh.work_date_local
    group by sh.employee_id, sh.work_date_local
  ),
  per_employee_day_paid as (
    select
      d.employee_id,
      d.work_date_local,
      d.shift_count_day,
      d.anomaly_count_day,
      d.hourly_rate_day,
      d.worked_seconds_day,
      d.break_seconds_day,
      d.unpaid_break_seconds_day,
      d.cap_min,
      public.round_seconds(
        greatest(d.worked_seconds_day - d.unpaid_break_seconds_day, 0),
        v_run.rounding_mode
      )::bigint as paid_seconds_day
    from per_employee_day d
  ),
  per_employee_period as (
    select
      x.employee_id,

      sum(x.paid_seconds_day)::bigint as paid_seconds,
      (sum(x.paid_seconds_day)::numeric / 3600.0) as paid_hours,

      sum(x.shift_count_day)::int as shift_count,
      sum(x.anomaly_count_day)::int as anomaly_count,

      -- TRUE gross pay: sum each day at that day's rate
      sum((x.paid_seconds_day::numeric / 3600.0) * x.hourly_rate_day) as gross_pay,

      -- Display rate: latest day's rate in period (for UI)
      (array_agg(x.hourly_rate_day order by x.work_date_local desc))[1] as hourly_rate_display,

      -- Full immutable audit snapshot: day-by-day breakdown
      jsonb_agg(
        jsonb_build_object(
          'work_date', x.work_date_local,
          'worked_hours', round((x.worked_seconds_day::numeric / 3600.0)::numeric, 4),
          'break_minutes', floor((x.break_seconds_day::numeric / 60.0)),
          'cap_minutes', x.cap_min,
          'unpaid_break_minutes', floor((x.unpaid_break_seconds_day::numeric / 60.0)),
          'paid_hours_rounded', round((x.paid_seconds_day::numeric / 3600.0)::numeric, 4),
          'hourly_rate', x.hourly_rate_day,
          'gross_for_day', round(((x.paid_seconds_day::numeric / 3600.0) * x.hourly_rate_day)::numeric, 2),
          'rounding_mode', v_run.rounding_mode
        )
        order by x.work_date_local
      ) as day_breakdown
    from per_employee_day_paid x
    group by x.employee_id
  )
  insert into public.payroll_run_lines (
    payroll_run_id,
    employee_id,
    paid_seconds,
    paid_hours,
    hourly_rate,
    gross_pay,
    shift_count,
    anomaly_count,
    details
  )
  select
    v_run.id,
    p.employee_id,
    p.paid_seconds,
    p.paid_hours,
    p.hourly_rate_display,
    p.gross_pay,
    p.shift_count,
    p.anomaly_count,
    jsonb_build_object(
      'rounding_mode', v_run.rounding_mode,
      'break_policy',  v_run.break_policy,
      'break_cap_source','store_locations.paid_break_cap_min',
      'rate_source','employee_rates (per day; fallback employees.hourly_rate)',
      'day_breakdown', p.day_breakdown
    )
  from per_employee_period p;

  get diagnostics v_rows = row_count;

  -- ✅ Hard fail if anyone lacked a rate on any day
  -- (We can't reference the CTE here; instead we check what we just wrote into details.day_breakdown)
  if exists (
    select 1
    from public.payroll_run_lines l
    cross join lateral jsonb_array_elements(l.details->'day_breakdown') as d(day)
    where l.payroll_run_id = v_run.id
      and (d.day->'hourly_rate') is null
  ) then
    raise exception 'Missing hourly rate for at least one employee on at least one work day in this period'
      using errcode='22023';
  end if;

  return v_rows;
end;
$function$;
CREATE OR REPLACE FUNCTION public.clock_in_now_geo(_employee_id uuid, _lat numeric, _lng numeric, _accuracy_m numeric, _photo_path text, _store_id uuid DEFAULT NULL::uuid)
 RETURNS public.time_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp_user uuid;
  v_store record;
  v_distance numeric;
  v_accuracy_max numeric := 150; -- meters
  v_row public.time_entries;

  v_now timestamptz := now();
  v_exp record;
  v_codes text[] := '{}'::text[];
  v_note  text := null;
begin
  -- BLOCK if pay period locked
  perform public.assert_unlocked_for_ts(v_now, 'clock-in');

  -- Photo required
  if coalesce(trim(_photo_path),'') = '' then
    raise exception 'Photo required' using errcode='22023';
  end if;

  -- Auth
  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then raise exception 'Employee not found'; end if;
  if v_emp_user <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;

  -- Store: explicit or first active
  if _store_id is not null then
    select * into v_store
    from public.store_locations s
    where s.id = _store_id and s.active is true;
  else
    select * into v_store
    from public.store_locations s
    where s.active is true
    order by s.created_at asc
    limit 1;
  end if;

  if v_store is null then raise exception 'No active store configured'; end if;

  -- Geofence
  v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  if _accuracy_m is null then _accuracy_m := 9999; end if;

  if v_distance > v_store.radius_m or _accuracy_m > v_accuracy_max then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)',
      round(v_distance,1), round(_accuracy_m,1);
  end if;

  -- Expected window
  select * into v_exp
  from public.resolve_expected_window(_employee_id, v_now, v_store.id);

  if v_exp.expected_start_ts is null or v_exp.expected_end_ts is null then
    v_codes := array_append(v_codes, 'UNSCHEDULED_DAY');
    v_note  := 'No schedule (override/recurring) for this day.';
    if v_store.schedule_enforce then
      raise exception 'Clock-in blocked: not scheduled today';
    end if;
  else
    if v_now < v_exp.expected_start_ts - (v_store.schedule_grace_in_m || ' minutes')::interval then
      v_codes := array_append(v_codes, 'EARLY_CLOCK_IN');
      if v_store.schedule_enforce then
        raise exception 'Clock-in blocked: too early for scheduled start';
      end if;
    elsif v_now > v_exp.expected_start_ts + (v_store.schedule_grace_in_m || ' minutes')::interval then
      v_codes := array_append(v_codes, 'LATE_CLOCK_IN');
      if v_store.schedule_enforce then
        raise exception 'Clock-in blocked: too late for scheduled start';
      end if;
    end if;
  end if;

  begin
    insert into public.time_entries (
      employee_id, clock_in,
      clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m, geo_ok_in,
      store_id, photo_in_path,
      expected_start_ts, expected_end_ts, schedule_codes, schedule_note
    ) values (
      _employee_id, v_now,
      _lat, _lng, _accuracy_m, v_distance, true,
      v_store.id, _photo_path,
      v_exp.expected_start_ts, v_exp.expected_end_ts, v_codes, v_note
    )
    returning * into v_row;
  exception when unique_violation then
    raise exception 'Open shift already exists';
  end;

  return v_row;
end;
$function$;
CREATE OR REPLACE FUNCTION public.clock_out_now_geo(_employee_id uuid, _lat numeric, _lng numeric, _accuracy_m numeric, _photo_path text, _store_id uuid DEFAULT NULL::uuid)
 RETURNS public.time_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_is_admin boolean := is_admin();
  v_today date := public.org_today_date();

  v_exc record;
  v_entry public.time_entries;

  v_target_store_id uuid;
  v_store record;
  v_dist numeric;
  v_geo_ok boolean;
begin
  -- Auth guard
  select e.user_id into v_user_id
  from public.employees e
  where e.id = _employee_id;

  if v_user_id is null then
    raise exception 'Employee not found';
  end if;

  if (not v_is_admin) and (v_user_id <> auth.uid()) then
    raise exception 'Not allowed';
  end if;

  if (not v_is_admin) and (_store_id is not null) then
    raise exception 'Not allowed to choose store';
  end if;

  -- Find open shift
  select *
  into v_entry
  from public.time_entries t
  where t.employee_id = _employee_id
    and t.clock_out is null
  order by t.clock_in desc
  limit 1;

  if v_entry.id is null then
    raise exception 'No open shift to clock out';
  end if;

  -- Get exception row for today (clock-out exceptions are keyed on "today")
  select *
  into v_exc
  from public.timeclock_day_exceptions x
  where x.employee_id = _employee_id
    and x.work_date = v_today
  limit 1;

  -- Decide which store we must be at for clock-out
  if _store_id is not null then
    v_target_store_id := _store_id;

  elsif v_exc.allow_clock_out_any_store is true then
    select store_id, distance_m into v_target_store_id, v_dist
    from public.pick_store_by_geo(_lat, _lng);

    if v_target_store_id is null then
      raise exception 'Clock-out allowed at any store today, but you are not inside any store geofence';
    end if;

  elsif v_exc.clock_out_store_id is not null then
    v_target_store_id := v_exc.clock_out_store_id;

  else
    -- Normal rule: must clock out at the same store as the shift
    if v_entry.store_id is null then
      raise exception 'Shift has no store_id; admin must fix this shift';
    end if;
    v_target_store_id := v_entry.store_id;
  end if;

  -- Load store
  select * into v_store
  from public.store_locations s
  where s.id = v_target_store_id;

  if v_store.id is null then
    raise exception 'Store not found';
  end if;

  if (not v_is_admin) and (v_store.active is distinct from true) then
    raise exception 'Store is inactive';
  end if;

  -- Geofence check
  if v_dist is null then
    v_dist := haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  v_geo_ok := (v_dist <= v_store.radius_m);

  if not v_geo_ok then
    raise exception 'You are not at the required store (%). Distance %.0fm, allowed %.0fm',
      v_store.name, v_dist, v_store.radius_m;
  end if;

  update public.time_entries
  set clock_out = now(),
      clock_out_lat = _lat, clock_out_lng = _lng,
      clock_out_accuracy_m = _accuracy_m,
      clock_out_distance_m = v_dist,
      geo_ok_out = true,
      photo_out_path = _photo_path
  where id = v_entry.id
  returning * into v_entry;
perform public.sync_shift_anomalies(v_entry.id);
  return v_entry;
end;

$function$;
CREATE OR REPLACE FUNCTION public.compute_schedule_flags(_employee_id uuid, _store_id uuid, _ts timestamp with time zone, _event text)
 RETURNS TABLE(codes text[], note text)
 LANGUAGE plpgsql
AS $function$
declare
  v_sched record;
  v_codes text[] := '{}';
  v_note text := null;
  v_local_ts time;
  v_grace int;
begin
  -- Convert timestamp to store-local time
  select (_ts at time zone s.timezone)::time, s.schedule_grace_in_m, s.schedule_grace_out_m
    into v_local_ts, v_grace, v_grace
  from public.store_locations s
  where s.id = _store_id;

  -- Find override first
  select *
  into v_sched
  from public.work_schedule_overrides
  where employee_id = _employee_id
    and work_date = (_ts at time zone 'America/New_York')::date
  limit 1;

  -- Else fallback to recurring schedule
  if v_sched is null then
    select *
    into v_sched
    from public.work_schedules
    where employee_id = _employee_id
      and store_id = _store_id
      and weekday = extract(dow from _ts)
      and active = true
    limit 1;
  end if;

  if v_sched is null then
    v_codes := array_append(v_codes, 'NO_SCHEDULE');
    return query select v_codes, 'No schedule found';
  end if;

  -- OFF day
  if v_sched.off then
    v_codes := array_append(v_codes, 'OFF_DAY_WORKED');
  end if;

  if _event = 'in' then
    if v_local_ts > (v_sched.start_local + make_interval(mins => v_grace)) then
      v_codes := array_append(v_codes, 'LATE_IN');
    end if;
  else
    if v_local_ts < (v_sched.end_local - make_interval(mins => v_grace)) then
      v_codes := array_append(v_codes, 'EARLY_OUT');
    end if;
  end if;

  return query select v_codes, v_note;
end;
$function$;
CREATE OR REPLACE FUNCTION public.create_pay_period(p_start_date date, p_end_date date, p_timezone text DEFAULT public.org_timezone(), p_note text DEFAULT NULL::text)
 RETURNS public.pay_periods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.pay_periods; begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode='42501'; end if;
  if p_end_date <= p_start_date then raise exception 'end_date must be after start_date' using errcode='22023'; end if;
  if exists (select 1 from public.pay_periods x
             where daterange(x.start_date,x.end_date,'[]') && daterange(p_start_date,p_end_date,'[]'))
  then raise exception 'Overlaps an existing pay period' using errcode='22023'; end if;
  insert into public.pay_periods (start_date,end_date,timezone,note)
  values (p_start_date,p_end_date,p_timezone,p_note) returning * into r; return r;
end $function$;
CREATE OR REPLACE FUNCTION public.create_payroll_run(_pay_period_id uuid, _rounding_mode text DEFAULT 'nearest_15'::text, _note text DEFAULT NULL::text)
 RETURNS public.payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p public.pay_periods;
  v_run public.payroll_runs;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  select * into v_p
  from public.pay_periods
  where id = _pay_period_id;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode='22023';
  end if;

  if _rounding_mode not in ('nearest_15','nearest_5','none') then
    raise exception 'Invalid rounding_mode' using errcode='22023';
  end if;

  insert into public.payroll_runs (
    pay_period_id, status, rounding_mode, break_policy, rules, note, created_by
  ) values (
    _pay_period_id,
    'draft',
    _rounding_mode,
    'paid_cap_per_day',
    jsonb_build_object(
      'break_cap_source','store_locations.paid_break_cap_min',
      'paid_break_cap_default_min',30
    ),
    _note,
    auth.uid()
  )
  returning * into v_run;

  return v_run;
end;
$function$;
CREATE OR REPLACE FUNCTION public.create_weekly_pay_period(week_start date, weeks integer DEFAULT 1, p_timezone text DEFAULT public.org_timezone(), p_note text DEFAULT NULL::text)
 RETURNS public.pay_periods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s date:=week_start; e date:=week_start + (weeks*7 - 1); r public.pay_periods;
begin r := public.create_pay_period(s,e,p_timezone,p_note); return r; end $function$;
CREATE OR REPLACE FUNCTION public.decrement_bag_stock(p_batch_id uuid, p_delta integer)
 RETURNS TABLE(batch_id uuid, new_quantity integer)
 LANGUAGE plpgsql
AS $function$
DECLARE v_item_stock_id uuid;
BEGIN
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RAISE EXCEPTION 'delta must be a positive integer';
  END IF;

  -- Find the stock row for this bag
  SELECT id INTO v_item_stock_id
  FROM public.item_stock_locations
  WHERE batch_id = p_batch_id
  LIMIT 1;

  IF v_item_stock_id IS NULL THEN
    RAISE EXCEPTION 'No stock row found for this bag';
  END IF;

  -- Atomic update
  UPDATE public.item_stock_locations
     SET quantity = quantity - p_delta
   WHERE id = v_item_stock_id
     AND quantity >= p_delta
  RETURNING batch_id, quantity INTO batch_id, new_quantity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient quantity in bag';
  END IF;

  -- Trigger will sync bulk_batches
  RETURN;
END;
$function$;
CREATE OR REPLACE FUNCTION public.delete_pay_period(_period_id uuid, _force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_admin boolean := public.is_admin();
  v_status text;
  v_run_count int;
  v_non_draft_count int;
begin
  if not v_is_admin then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  if _period_id is null then
    raise exception 'Missing period id' using errcode='22023';
  end if;

  select p.status into v_status
  from public.pay_periods p
  where p.id = _period_id;

  if v_status is null then
    raise exception 'Pay period not found' using errcode='22023';
  end if;

  -- Never delete locked periods
  if v_status = 'locked' then
    raise exception 'Cannot delete: pay period is locked' using errcode='22023';
  end if;

  -- Count runs
  select count(*) into v_run_count
  from public.payroll_runs r
  where r.pay_period_id = _period_id;

  if v_run_count = 0 then
    delete from public.pay_periods where id = _period_id;
    return;
  end if;

  -- If runs exist, only allow delete when _force=true AND all runs are draft
  select count(*) into v_non_draft_count
  from public.payroll_runs r
  where r.pay_period_id = _period_id
    and r.status <> 'draft';

  if not _force then
    raise exception 'Cannot delete: pay period has % payroll run(s). Delete the run(s) first or call with _force=true.', v_run_count
      using errcode='22023';
  end if;

  if v_non_draft_count > 0 then
    raise exception 'Cannot force delete: pay period has % non-draft run(s)', v_non_draft_count
      using errcode='22023';
  end if;

  -- Delete draft runs + lines for this period
  delete from public.payroll_run_lines l
  using public.payroll_runs r
  where l.payroll_run_id = r.id
    and r.pay_period_id = _period_id;

  delete from public.payroll_runs
  where pay_period_id = _period_id;

  delete from public.pay_periods
  where id = _period_id;
end;
$function$;
CREATE OR REPLACE FUNCTION public.delete_payroll_run(_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_admin boolean := public.is_admin();
  v_status text;
  v_period_status text;
  v_period_id uuid;
begin
  if not v_is_admin then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  if _run_id is null then
    raise exception 'Missing run id' using errcode='22023';
  end if;

  -- Load run status + period
  select r.status, r.pay_period_id
    into v_status, v_period_id
  from public.payroll_runs r
  where r.id = _run_id;

  if v_status is null then
    raise exception 'Payroll run not found' using errcode='22023';
  end if;

  -- Only draft runs may be deleted
  if v_status <> 'draft' then
    raise exception 'Cannot delete: only draft runs may be deleted (current: %)', v_status
      using errcode='22023';
  end if;

  -- Block delete if the pay period is locked
  select p.status
    into v_period_status
  from public.pay_periods p
  where p.id = v_period_id;

  if v_period_status = 'locked' then
    raise exception 'Cannot delete: pay period is locked'
      using errcode='22023';
  end if;

  -- Optional safety: block if any payments exist for this run
  -- Uncomment if you have this table:
  -- if exists (select 1 from public.contractor_payments cp where cp.payroll_run_id = _run_id) then
  --   raise exception 'Cannot delete: payments already exist for this run'
  --     using errcode='22023';
  -- end if;

  -- Delete children first (safe even if you later add FK cascade)
  delete from public.payroll_run_lines
  where payroll_run_id = _run_id;

  delete from public.payroll_runs
  where id = _run_id;

end;
$function$;
CREATE OR REPLACE FUNCTION public.employee_legal_addresses_make_current()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.is_current then
    update public.employee_legal_addresses
      set is_current = false
    where employee_id = new.employee_id
      and id <> new.id
      and is_current = true;
  end if;

  return new;
end;
$function$;
create or replace view "public"."employee_tax_compliance" as  SELECT e.id AS employee_id,
    e.worker_type,
    (EXISTS ( SELECT 1
           FROM public.employee_tax_docs d
          WHERE ((d.employee_id = e.id) AND (d.doc_type = 'w9'::public.tax_doc_type) AND (d.status = 'verified'::public.tax_doc_status) AND (d.is_active = true)))) AS has_verified_w9,
    (EXISTS ( SELECT 1
           FROM public.employee_tax_docs d
          WHERE ((d.employee_id = e.id) AND (d.doc_type = 'w4'::public.tax_doc_type) AND (d.status = 'verified'::public.tax_doc_status) AND (d.is_active = true)))) AS has_verified_w4
   FROM public.employees e;
CREATE OR REPLACE FUNCTION public.end_break_now_geo(_employee_id uuid, _lat numeric, _lng numeric, _accuracy_m numeric, _photo_path text, _store_id uuid DEFAULT NULL::uuid)
 RETURNS public.time_breaks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp_user uuid;

  v_accuracy_max numeric := 500;
  v_entry_id uuid;
  v_shift_store_id uuid;

  v_shift_store record;
  v_day date;

  v_emp_exc record;
  v_store_exc record;

  v_any_store boolean := false;
  v_target_store_id uuid;

  v_store record;
  v_distance numeric;

  v_break public.time_breaks;
  v_break_id uuid;

  v_now timestamptz := now();

  v_cap_m integer := 30;
  v_total_seconds bigint := 0;
  v_codes text[] := '{}';
  v_break_start timestamptz;
begin
  -- BLOCK if pay period locked
  perform public.assert_unlocked_for_ts(v_now, 'end break');

  if coalesce(trim(_photo_path),'') = '' then
    raise exception 'Photo required' using errcode='22023';
  end if;

  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then raise exception 'Employee not found'; end if;
  if v_emp_user <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;

  if _store_id is not null and not public.is_admin() then
    raise exception 'Not allowed to choose store';
  end if;

  v_entry_id := public.get_open_shift_id(_employee_id);
  if v_entry_id is null then
    raise exception 'No open shift to end a break';
  end if;

  select t.store_id into v_shift_store_id
  from public.time_entries t
  where t.id = v_entry_id;

  if v_shift_store_id is null then
    raise exception 'Shift has no store assignment; cannot end break';
  end if;

  select * into v_shift_store
  from public.store_locations s
  where s.id = v_shift_store_id;

  if v_shift_store is null or v_shift_store.active is not true then
    raise exception 'Shift store is not active or not configured';
  end if;

  select b.id, b.started_at into v_break_id, v_break_start
  from public.time_breaks b
  where b.time_entry_id = v_entry_id
    and b.ended_at is null
  order by b.started_at desc
  limit 1;

  if v_break_id is null then
    raise exception 'No active break to end';
  end if;

  v_day := ((v_break_start at time zone v_shift_store.timezone)::date);

  select * into v_emp_exc
  from public.timeclock_day_exceptions x
  where x.employee_id = _employee_id
    and x.work_date = v_day
  limit 1;

  select * into v_store_exc
  from public.timeclock_store_exceptions sx
  where sx.store_id = v_shift_store_id
    and sx.work_date = v_day
  limit 1;

  v_any_store :=
    coalesce(v_emp_exc.allow_clock_in_any_store,false)
    or coalesce(v_emp_exc.allow_clock_out_any_store,false)
    or coalesce(v_store_exc.allow_clock_in_any_store,false)
    or coalesce(v_store_exc.allow_clock_out_any_store,false);

  if _store_id is not null then
    v_target_store_id := _store_id;

    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id
      and s.active is true;

    if v_store is null then
      raise exception 'Selected store is not active';
    end if;

    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);

  elsif v_any_store then
    select s.*, q.distance_m
    into v_store
    from (
      select s.id,
             public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      from public.store_locations s
      where s.active is true
    ) q
    join public.store_locations s on s.id = q.id
    where q.distance_m <= s.radius_m
    order by q.distance_m asc
    limit 1;

    if v_store is null then
      raise exception 'Break allowed at any store today, but you are not inside any active store geofence';
    end if;

    v_distance := v_store.distance_m;

  else
    v_target_store_id :=
      coalesce(
        v_emp_exc.clock_out_store_id,
        v_emp_exc.clock_in_store_id,
        v_store_exc.clock_out_store_id,
        v_store_exc.clock_in_store_id,
        v_shift_store_id
      );

    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id
      and s.active is true;

    if v_store is null then
      raise exception 'No active store configured for break enforcement';
    end if;

    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then _accuracy_m := 9999; end if;

  if v_distance > v_store.radius_m or _accuracy_m > v_accuracy_max then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)',
      round(v_distance,1), round(_accuracy_m,1);
  end if;

  update public.time_breaks
  set ended_at = v_now,
      end_lat = _lat, end_lng = _lng, end_accuracy_m = _accuracy_m,
      geo_ok_end = true,
      photo_end_path = _photo_path
  where id = v_break_id;

  -- Break cap check (seconds vs minutes*60)
  v_cap_m := coalesce(v_shift_store.paid_break_cap_min, 30);

  select coalesce(sum(extract(epoch from (b.ended_at - b.started_at)))::bigint, 0)
    into v_total_seconds
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  where t.employee_id = _employee_id
    and ((b.started_at at time zone v_shift_store.timezone)::date) = v_day
    and b.ended_at is not null;

  if (v_total_seconds > (v_cap_m * 60)) then
    v_codes := array_append(v_codes, 'DAILY_BREAK_OVER_CAP');
  end if;

  update public.time_breaks
  set break_codes = v_codes
  where id = v_break_id
  returning * into v_break;

  return v_break;
end;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_contractor_agreement_required()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_active text;
begin
  -- only applies to contractors
  if lower(coalesce(new.worker_type,'employee')) = 'contractor' then
    if new.agreement_version_required is null or length(trim(new.agreement_version_required)) = 0 then
      v_active := public.get_active_agreement_version();
      if v_active is not null then
        new.agreement_version_required := v_active;
      end if;
    end if;
  end if;

  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.enqueue_sms(_to_phone text, _body text, _send_after timestamp with time zone DEFAULT now(), _meta jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_id uuid;
begin
  insert into public.sms_outbox (to_phone, body, send_after, meta)
  values (_to_phone, _body, coalesce(_send_after, now()), coalesce(_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $function$;
CREATE OR REPLACE FUNCTION public.finalize_payroll_run(_payroll_run_id uuid, _note text DEFAULT NULL::text)
 RETURNS public.payroll_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.payroll_runs;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id
  for update;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode='22023';
  end if;

  if v_run.status <> 'draft' then
    raise exception 'Only draft runs can be finalized' using errcode='22023';
  end if;

  if not exists (select 1 from public.payroll_run_lines l where l.payroll_run_id = v_run.id) then
    raise exception 'Cannot finalize: payroll run has no lines' using errcode='22023';
  end if;

  update public.payroll_runs
  set status = 'final',
      finalized_at = now(),
      finalized_by = auth.uid(),
      note = case
        when _note is null or trim(_note) = '' then note
        else coalesce(note,'') || case when note is null then '' else E'\n' end || _note
      end
  where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$function$;
CREATE OR REPLACE FUNCTION public.generate_payroll_statements_for_run(_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_paid numeric;
  v_due numeric;

  v_minutes_worked int;
  v_break_minutes int;
  v_unpaid_break_minutes int;
  v_paid_break_minutes int;
  v_rounded_minutes int;
  v_hours_paid numeric;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;

  for r in
    select
      pr.id as payroll_run_id,
      pr.status as run_status,
      pr.rounding_mode,
      pr.pay_period_id,
      l.employee_id,
      l.shift_count,
      l.hourly_rate,
      l.gross_pay,
      l.details,
      coalesce(p.paid_total, 0) as paid_total
    from public.payroll_runs pr
    join public.payroll_run_lines l on l.payroll_run_id = pr.id
    left join (
      select payroll_run_id, employee_id, sum(amount) as paid_total
      from public.payroll_payments
      where payroll_run_id = _run_id
      group by payroll_run_id, employee_id
    ) p on p.payroll_run_id = pr.id and p.employee_id = l.employee_id
    where pr.id = _run_id
  loop
    v_paid := r.paid_total;
    v_due := greatest(0, r.gross_pay - v_paid);

    -- totals from details.day_breakdown[]
    v_minutes_worked := 0;
    v_break_minutes := 0;
    v_unpaid_break_minutes := 0;
    v_paid_break_minutes := 0;
    v_rounded_minutes := 0;

    -- If day_breakdown exists, compute from it
    if (r.details ? 'day_breakdown') then
      select
        coalesce(sum(round((d->>'worked_hours')::numeric * 60)),0)::int,
        coalesce(sum((d->>'break_minutes')::numeric),0)::int,
        coalesce(sum((d->>'unpaid_break_minutes')::numeric),0)::int,
        coalesce(sum(round((d->>'paid_hours_rounded')::numeric * 60)),0)::int
      into
        v_minutes_worked,
        v_break_minutes,
        v_unpaid_break_minutes,
        v_rounded_minutes
      from jsonb_array_elements(r.details->'day_breakdown') d;

      v_paid_break_minutes := greatest(0, v_break_minutes - v_unpaid_break_minutes);
    else
      -- fallback (rare): infer from paid_seconds
      v_rounded_minutes := coalesce(round((r.details->>'paid_seconds')::numeric / 60),0)::int;
      v_minutes_worked := v_rounded_minutes;
      v_break_minutes := 0;
      v_unpaid_break_minutes := 0;
      v_paid_break_minutes := 0;
    end if;

    -- paid minutes = worked - unpaid break
    -- (matches your UI logic)
    v_hours_paid := (v_rounded_minutes::numeric / 60.0);

    insert into public.payroll_statements (
      payroll_run_id, pay_period_id, employee_id,
      run_status, rounding_mode,
      hourly_rate, gross_pay, total_paid, total_due,
      shifts_count, minutes_worked, break_minutes, paid_break_minutes, unpaid_break_minutes,
      paid_minutes, rounded_minutes, hours_paid,
      details
    ) values (
      r.payroll_run_id, r.pay_period_id, r.employee_id,
      r.run_status, r.rounding_mode,
      r.hourly_rate, r.gross_pay, v_paid, v_due,
      r.shift_count, v_minutes_worked, v_break_minutes, v_paid_break_minutes, v_unpaid_break_minutes,
      greatest(0, v_minutes_worked - v_unpaid_break_minutes), v_rounded_minutes, v_hours_paid,
      r.details
    )
    on conflict (payroll_run_id, employee_id)
    do update set
      run_status = excluded.run_status,
      rounding_mode = excluded.rounding_mode,
      hourly_rate = excluded.hourly_rate,
      gross_pay = excluded.gross_pay,
      total_paid = excluded.total_paid,
      total_due = excluded.total_due,
      shifts_count = excluded.shifts_count,
      minutes_worked = excluded.minutes_worked,
      break_minutes = excluded.break_minutes,
      paid_break_minutes = excluded.paid_break_minutes,
      unpaid_break_minutes = excluded.unpaid_break_minutes,
      paid_minutes = excluded.paid_minutes,
      rounded_minutes = excluded.rounded_minutes,
      hours_paid = excluded.hours_paid,
      details = excluded.details;
  end loop;
end;
$function$;
CREATE OR REPLACE FUNCTION public.get_active_agreement_version()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select av.version
  from public.agreement_versions av
  where av.active = true
  order by av.created_at desc
  limit 1;
$function$;
CREATE OR REPLACE FUNCTION public.get_active_contractor_agreement_version()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select version
  from public.agreement_versions
  where active = true
  order by created_at desc
  limit 1
$function$;
CREATE OR REPLACE FUNCTION public.get_employee_schedule(_employee_id uuid, _start date, _end date)
 RETURNS TABLE(work_date date, start_ts timestamp with time zone, end_ts timestamp with time zone, source text, store_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with days as (
    select generate_series(_start, _end, '1 day'::interval)::date as d
  ),
  base as (
    -- match weekday & effective range
    select
      dd.d as work_date,
      ws.store_id,
      ws.start_local,
      ws.end_local,
      'recurring'::text as source
    from days dd
    join public.work_schedules ws
      on ws.employee_id = _employee_id
     and ws.active is true
     and ws.weekday = extract(dow from dd.d)
     and dd.d >= ws.effective_from
     and (ws.effective_to is null or dd.d <= ws.effective_to)
  ),
  ov as (
    select
      o.work_date,
      o.store_id,
      o.start_local,
      o.end_local,
      o.off,
      'override'::text as source
    from public.work_schedule_overrides o
    where o.employee_id = _employee_id
      and o.work_date between _start and _end
  ),
  merged as (
    -- override wins; 'off' nulls out times
    select
      coalesce(ov.work_date, base.work_date) as work_date,
      coalesce(ov.store_id, base.store_id)   as store_id,
      case when coalesce(ov.off,false) then null else coalesce(ov.start_local, base.start_local) end as start_local,
      case when coalesce(ov.off,false) then null else coalesce(ov.end_local,   base.end_local)   end as end_local,
      case when coalesce(ov.off,false) then 'off' else coalesce(ov.source, base.source) end as source
    from base
    full outer join ov on ov.work_date = base.work_date
  )
  select
    m.work_date,
    -- Convert local store time to timestamptz in UTC:
    ((m.work_date::timestamp + m.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    ((m.work_date::timestamp + m.end_local)   at time zone coalesce(sl.timezone, 'America/New_York')) as end_ts,
    m.source,
    m.store_id
  from merged m
  left join public.store_locations sl on sl.id = m.store_id
  where m.start_local is not null and m.end_local is not null
  order by m.work_date, start_ts;
$function$;
CREATE OR REPLACE FUNCTION public.get_manager_phones(_employee_id uuid)
 RETURNS TABLE(phone_e164 text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select up.phone_e164
  from public.employee_managers m
  join public.employees me on me.id = m.manager_employee_id
  join public.user_phones up on up.user_id = me.user_id
  where m.employee_id = _employee_id
    and up.can_sms is true
    and up.verified_at is not null;
$function$;
CREATE OR REPLACE FUNCTION public.get_open_shift_id(_employee_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.id
  from public.time_entries t
  where t.employee_id = _employee_id and t.clock_out is null
  order by t.clock_in desc
  limit 1
$function$;
CREATE OR REPLACE FUNCTION public.get_schedule_range_all(_start date, _end date)
 RETURNS TABLE(work_date date, employee_id uuid, display_name text, start_ts timestamp with time zone, end_ts timestamp with time zone, source text, store_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    m.work_date,
    m.employee_id,
    e.display_name,
    ((m.work_date::timestamp + m.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    ((m.work_date::timestamp + m.end_local)   at time zone coalesce(sl.timezone, 'America/New_York')) as end_ts,
    m.source,
    m.store_id
  from (
    with days as (
      select generate_series(_start, _end, '1 day'::interval)::date as d
    ),
    base as (
      -- recurring rules expanded to concrete days
      select
        dd.d                as work_date,
        ws.employee_id,
        ws.store_id,
        ws.start_local,
        ws.end_local,
        'recurring'::text   as source
      from days dd
      join public.work_schedules ws
        on ws.active is true
       and dd.d >= ws.effective_from
       and (ws.effective_to is null or dd.d <= ws.effective_to)
       and extract(dow from dd.d) = ws.weekday
    ),
    ov as (
      -- one-off overrides in range
      select
        o.work_date,
        o.employee_id,
        o.store_id,
        o.start_local,
        o.end_local,
        o.off,
        'override'::text as source
      from public.work_schedule_overrides o
      where o.work_date between _start and _end
    )
    -- merge: override wins; 'off' nulls out times
    select
      coalesce(ov.work_date, base.work_date) as work_date,
      coalesce(ov.employee_id, base.employee_id) as employee_id,
      coalesce(ov.store_id, base.store_id)       as store_id,
      case when coalesce(ov.off,false) then null else coalesce(ov.start_local, base.start_local) end as start_local,
      case when coalesce(ov.off,false) then null else coalesce(ov.end_local,   base.end_local)   end as end_local,
      case when coalesce(ov.off,false) then 'off' else coalesce(ov.source, base.source) end as source
    from base
    full outer join ov
      on ov.work_date = base.work_date
     and ov.employee_id = base.employee_id
  ) m
  join public.employees e on e.id = m.employee_id and e.active is true
  left join public.store_locations sl on sl.id = m.store_id
  where m.start_local is not null and m.end_local is not null
    and public.is_admin()
  order by m.work_date, e.display_name;
$function$;
CREATE OR REPLACE FUNCTION public.get_schedule_slot_for_ts(_employee_id uuid, _ts timestamp with time zone)
 RETURNS TABLE(start_ts timestamp with time zone, end_ts timestamp with time zone, source text, store_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.start_ts, s.end_ts, s.source, s.store_id
  from public.get_employee_schedule(_employee_id, (_ts at time zone 'utc')::date, (_ts at time zone 'utc')::date) s
  order by s.start_ts
  limit 1
$function$;
CREATE OR REPLACE FUNCTION public.get_store_inventory(show_out_of_stock boolean DEFAULT false)
 RETURNS TABLE(id uuid, title text, description text, sale_price numeric, barcode text, qr_code text, photo_url text, photos text[], categories text[], qr_type text, created_at timestamp with time zone, total_stock bigint, in_stock boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    it.id,
    it.title,
    it.description,
    it.sale_price,
    it.barcode,
    it.qr_code,
    it.photo_url,
    it.photos,
    it.categories,
    it.qr_type,
    it.created_at,
    coalesce(sum(isl.quantity), 0)::bigint as total_stock,
    (coalesce(sum(isl.quantity), 0) > 0) as in_stock
  from public.item_types it
  left join public.item_stock_locations isl
    on isl.item_id = it.id
  group by
    it.id, it.title, it.description, it.sale_price, it.barcode, it.qr_code,
    it.photo_url, it.photos, it.categories, it.qr_type, it.created_at
  having (show_out_of_stock = true) or (coalesce(sum(isl.quantity), 0) > 0)
  order by it.created_at desc;
$function$;
CREATE OR REPLACE FUNCTION public.haversine_meters(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  select
    2 * 6371000 * asin(
      sqrt(
        pow(sin(radians((lat2 - lat1) / 2)), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians((lng2 - lng1) / 2)), 2)
      )
    );
$function$;
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and e.role = 'admin'
  );
$function$;
CREATE OR REPLACE FUNCTION public.mark_invite_accepted()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.employees
  set accepted_at = coalesce(accepted_at, now())
  where user_id = auth.uid();
end;
$function$;
create materialized view "public"."mv_monthly_hours" as  SELECT e.id AS employee_id,
    (date_trunc('month'::text, (t.clock_in AT TIME ZONE 'America/New_York'::text)))::date AS month_start,
    e.display_name,
    count(*) AS shifts_count,
    round((sum(EXTRACT(epoch FROM (t.clock_out - t.clock_in))) / 3600.0), 2) AS total_hours
   FROM (public.time_entries t
     JOIN public.employees e ON ((e.id = t.employee_id)))
  WHERE (t.clock_out IS NOT NULL)
  GROUP BY e.id, ((date_trunc('month'::text, (t.clock_in AT TIME ZONE 'America/New_York'::text)))::date), e.display_name;
CREATE OR REPLACE FUNCTION public.next_week_start(ts timestamp with time zone, tz text DEFAULT public.org_timezone(), week_start_dow integer DEFAULT public.org_week_start_dow())
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
AS $function$
  select public.week_start(ts, tz, week_start_dow) + interval '7 days'
$function$;
CREATE OR REPLACE FUNCTION public.notify_break_ended(_time_break_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v record; v_cap int; v_minutes int; v_phone text; v_msg text;
begin
  select b.*, t.employee_id, e.display_name, coalesce(s.paid_break_cap_min,30) as cap
    into v
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  join public.employees e on e.id = t.employee_id
  left join public.store_locations s on s.id = t.store_id
  where b.id = _time_break_id;

  if not found or v.ended_at is null then return; end if;

  v_cap := greatest(coalesce(v.cap,30), 1);
  v_minutes := floor(extract(epoch from (v.ended_at - v.started_at))/60);

  if v_minutes <= v_cap then return; end if;

  v_msg := format('🚩 %s break overage: %s min (cap %s).', v.display_name, v_minutes, v_cap);
  for v_phone in
    select phone_e164 from public.get_manager_phones(v.employee_id)
  loop
    perform public.enqueue_sms(v_phone, v_msg, now(), jsonb_build_object('type','break_over','time_break_id',_time_break_id));
  end loop;
end $function$;
CREATE OR REPLACE FUNCTION public.notify_break_started(_time_break_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v record; v_cap int; v_send_at timestamptz; v_phone text; v_tz text; v_msg text;
begin
  select b.*, t.employee_id, e.display_name, s.timezone, coalesce(s.paid_break_cap_min,30) as cap
    into v
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  join public.employees e on e.id = t.employee_id
  left join public.store_locations s on s.id = t.store_id
  where b.id = _time_break_id;

  if not found then return; end if;
  v_cap := greatest(coalesce(v.cap,30), 1);
  v_tz  := coalesce(v.timezone, 'America/New_York');

  v_send_at := v.started_at + make_interval(mins => greatest(v_cap - 5, 1));

  select up.phone_e164 into v_phone
  from public.user_phones up
  where up.user_id = (select user_id from public.employees where id = v.employee_id)
    and up.can_sms is true and up.verified_at is not null;

  if v_phone is null then return; end if;

  v_msg := '⏳ Break reminder: 5 minutes left.';
  perform public.enqueue_sms(
    v_phone, v_msg, v_send_at,
    jsonb_build_object('type','break_5_left','time_break_id',_time_break_id)
  );
end $function$;
CREATE OR REPLACE FUNCTION public.notify_shift_flags(_time_entry_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v record;
  v_codes text[];
  v_tz text;
  v_local_ts text;
  v_msg text;
  v_phone text;
begin
  select t.*, e.display_name, s.timezone as store_tz
    into v
  from public.time_entries t
  join public.employees e on e.id = t.employee_id
  left join public.store_locations s on s.id = t.store_id
  where t.id = _time_entry_id;
  if not found then return; end if;

  v_codes := coalesce(v.schedule_codes, '{}'::text[]);
  if array_length(v_codes,1) is null then return; end if;

  -- Alert-worthy codes
  if not (
    'EARLY_CLOCK_IN' = any(v_codes) or
    'LATE_CLOCK_IN'  = any(v_codes) or
    'UNSCHEDULED_DAY'= any(v_codes) or
    'EARLY_CLOCK_OUT'= any(v_codes) or
    'LATE_CLOCK_OUT' = any(v_codes)
  ) then
    return;
  end if;

  v_tz := coalesce(v.store_tz, 'America/New_York');
  v_local_ts := to_char((coalesce(v.clock_out, v.clock_in) at time zone v_tz), 'YYYY-MM-DD HH24:MI');

  v_msg := format(
    '⏰ %s: %s. %s at %s.',
    v.display_name,
    array_to_string(v_codes, ', '),
    case when v.clock_out is null then 'Clock-in' else 'Clock-out' end,
    v_local_ts
  );

  for v_phone in
    select phone_e164 from public.get_manager_phones(v.employee_id)
  loop
    perform public.enqueue_sms(v_phone, v_msg, now(), jsonb_build_object('type','shift_flag','time_entry_id',_time_entry_id));
  end loop;
end $function$;
CREATE OR REPLACE FUNCTION public.org_paid_break_minutes_per_day()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$ select 30::int $function$;
CREATE OR REPLACE FUNCTION public.org_timezone()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$ select 'America/New_York'::text; $function$;
CREATE OR REPLACE FUNCTION public.org_today_date()
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$
  select (now() at time zone 'America/New_York')::date;
$function$;
CREATE OR REPLACE FUNCTION public.org_week_start_dow()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$ select 0::int; $function$;
CREATE OR REPLACE FUNCTION public.payroll_lock_period(_period_id uuid, _note text DEFAULT NULL::text, _force boolean DEFAULT false)
 RETURNS public.pay_periods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p public.pay_periods;
  v_start timestamptz;
  v_end   timestamptz;

  v_open_shifts int;
  v_open_breaks int;
  v_need_approval int;
  v_need_waive int;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_p
  from public.pay_periods
  where id = _period_id
  for update;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  if v_p.status = 'locked' then
    return v_p;
  end if;

  v_start := make_timestamptz(
    extract(year from v_p.start_date)::int,
    extract(month from v_p.start_date)::int,
    extract(day from v_p.start_date)::int,
    0,0,0, v_p.timezone
  );

  v_end := make_timestamptz(
    extract(year from (v_p.end_date + 1))::int,
    extract(month from (v_p.end_date + 1))::int,
    extract(day from (v_p.end_date + 1))::int,
    0,0,0, v_p.timezone
  );

  -- A) disallow open shifts unless _force
  if not _force then
    select count(*) into v_open_shifts
    from public.time_entries t
    where t.clock_out is null
      and t.clock_in < v_end;

    if v_open_shifts > 0 then
      raise exception 'Cannot lock: % open shift(s) overlap this period', v_open_shifts
        using errcode='22023';
    end if;

    -- NEW: disallow open breaks unless _force
    select count(*) into v_open_breaks
    from public.time_breaks b
    join public.time_entries t on t.id = b.time_entry_id
    where b.ended_at is null
      and t.clock_in < v_end;

    if v_open_breaks > 0 then
      raise exception 'Cannot lock: % open break(s) overlap this period', v_open_breaks
        using errcode='22023';
    end if;
  end if;

  -- B) every overlapping CLOSED shift must be approved
  select count(*) into v_need_approval
  from public.time_entries t
  where t.clock_out is not null
    and t.clock_in < v_end and t.clock_out > v_start
    and not exists (select 1 from public.shift_approvals sa where sa.time_entry_id = t.id);

  if v_need_approval > 0 then
    raise exception 'Cannot lock: % shift(s) pending approval in this period', v_need_approval
      using errcode='22023';
  end if;

  -- C) anomalies must be WAIVED
  select count(*) into v_need_waive
  from public.v_shift_anomalies a
  where a.clock_in < v_end and a.clock_out > v_start
    and a.has_anomaly
    and coalesce(a.approval_status,'') <> 'waived';

  if v_need_waive > 0 then
    raise exception 'Cannot lock: % shift(s) have anomalies not waived', v_need_waive
      using errcode='22023';
  end if;

  update public.pay_periods
  set status    = 'locked',
      locked_at = now(),
      locked_by = auth.uid(),
      note      = case
                    when _note is null or trim(_note) = '' then note
                    else coalesce(note,'') || case when note is null then '' else E'\n' end || _note
                  end
  where id = v_p.id
  returning * into v_p;

  return v_p;
end;
$function$;
CREATE OR REPLACE FUNCTION public.payroll_unlock_period(_period_id uuid, _note text DEFAULT NULL::text)
 RETURNS public.pay_periods
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p public.pay_periods;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  update public.pay_periods
  set status    = 'open',
      locked_at = null,
      locked_by = null,
      note      = case when _note is null or trim(_note) = '' then note
                       else coalesce(note,'') || case when note is null then '' else E'\n' end || _note end
  where id = _period_id
  returning * into v_p;

  if v_p.id is null then
    raise exception 'Pay period not found' using errcode = '22023';
  end if;

  return v_p;
end;
$function$;
CREATE OR REPLACE FUNCTION public.pick_store_by_geo(_lat numeric, _lng numeric)
 RETURNS TABLE(store_id uuid, distance_m numeric)
 LANGUAGE sql
 STABLE
AS $function$
  select s.id as store_id,
         haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
  from public.store_locations s
  where s.active = true
    and s.lat is not null and s.lng is not null
    and haversine_meters(_lat, _lng, s.lat, s.lng) <= s.radius_m
  order by haversine_meters(_lat, _lng, s.lat, s.lng) asc
  limit 1;
$function$;
CREATE OR REPLACE FUNCTION public.preview_payroll_statement(_run_id uuid, _employee_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_admin boolean := public.is_admin();
  v_user_id uuid;

  r record;

  v_paid numeric := 0;
  v_due  numeric := 0;

  v_minutes_worked int := 0;
  v_break_minutes int := 0;
  v_unpaid_break_minutes int := 0;
  v_paid_break_minutes int := 0;
  v_rounded_minutes int := 0;
  v_hours_paid numeric := 0;

  v_flags jsonb := '[]'::jsonb;
begin
  -- auth: admin OR employee themselves
  select e.user_id into v_user_id
  from public.employees e
  where e.id = _employee_id;

  if v_user_id is null then
    raise exception 'Employee not found';
  end if;

  if (not v_is_admin) and (v_user_id <> auth.uid()) then
    raise exception 'Not allowed';
  end if;

  -- main run/line + paid total (from contractor_payments)
  select
    pr.id as payroll_run_id,
    pr.status as run_status,
    pr.rounding_mode,
    pr.created_at as run_created_at,
    pr.finalized_at as run_finalized_at,

    pp.id as pay_period_id,
    pp.start_date,
    pp.end_date,
    (pp.status = 'locked') as period_locked,

    l.employee_id,
    l.shift_count,
    l.hourly_rate,
    l.gross_pay,
    l.details,

    coalesce(p.paid_total, 0) as paid_total
  into r
  from public.payroll_runs pr
  join public.pay_periods pp
    on pp.id = pr.pay_period_id
  join public.payroll_run_lines l
    on l.payroll_run_id = pr.id
   and l.employee_id = _employee_id
  left join (
    select payroll_run_id, employee_id, sum(amount) as paid_total
    from public.contractor_payments
    where payroll_run_id = _run_id
      and employee_id = _employee_id
      and status = 'paid'
    group by payroll_run_id, employee_id
  ) p on p.payroll_run_id = pr.id and p.employee_id = l.employee_id
  where pr.id = _run_id;

  if r.payroll_run_id is null then
    raise exception 'Run line not found';
  end if;

  v_paid := r.paid_total;
  v_due  := greatest(0, r.gross_pay - v_paid);

  -- totals from details.day_breakdown[]
  if (r.details ? 'day_breakdown') then
    select
      coalesce(sum(round((d->>'worked_hours')::numeric * 60)),0)::int,
      coalesce(sum((d->>'break_minutes')::numeric),0)::int,
      coalesce(sum((d->>'unpaid_break_minutes')::numeric),0)::int,
      coalesce(sum(round((d->>'paid_hours_rounded')::numeric * 60)),0)::int
    into
      v_minutes_worked,
      v_break_minutes,
      v_unpaid_break_minutes,
      v_rounded_minutes
    from jsonb_array_elements(r.details->'day_breakdown') d;

    v_paid_break_minutes := greatest(0, v_break_minutes - v_unpaid_break_minutes);
  end if;

  v_hours_paid := (v_rounded_minutes::numeric / 60.0);

  -- FLAGS (computed, derived from live data)
  v_flags := (
    select coalesce(jsonb_agg(flag), '[]'::jsonb)
    from (
      -- Pending approval (no shift_approvals row)
      select jsonb_build_object(
        'type', 'pending_review',
        'time_entry_id', te.id,
        'date', te.clock_in::date,
        'message', 'Shift pending approval'
      ) as flag
      from public.time_entries te
      left join public.shift_approvals sa
        on sa.time_entry_id = te.id
      where te.employee_id = _employee_id
        and te.clock_in::date between r.start_date and r.end_date
        and sa.time_entry_id is null

      union all

      -- Geo failures
      select jsonb_build_object(
        'type', 'geo',
        'time_entry_id', te.id,
        'date', te.clock_in::date,
        'message', 'Geolocation check failed'
      ) as flag
      from public.time_entries te
      where te.employee_id = _employee_id
        and te.clock_in::date between r.start_date and r.end_date
        and (te.geo_ok_in = false or te.geo_ok_out = false)

      union all

      -- Edited shifts (shift_adjustments exist)
      select jsonb_build_object(
        'type', 'edit',
        'time_entry_id', adj.time_entry_id,
        'date', adj.edited_at::date,
        'message', 'Shift manually adjusted'
      ) as flag
      from public.shift_adjustments adj
      join public.time_entries te on te.id = adj.time_entry_id
      where te.employee_id = _employee_id
        and adj.edited_at::date between r.start_date and r.end_date
    ) flags
  );

  return jsonb_build_object(
    'run', jsonb_build_object(
      'payroll_run_id', r.payroll_run_id,
      'status', r.run_status,
      'rounding_mode', r.rounding_mode,
      'created_at', r.run_created_at,
      'finalized_at', r.run_finalized_at
    ),
    'pay_period', jsonb_build_object(
      'pay_period_id', r.pay_period_id,
      'start_date', r.start_date,
      'end_date', r.end_date,
      'locked', r.period_locked
    ),
    'employee', jsonb_build_object(
      'employee_id', r.employee_id
    ),
    'summary', jsonb_build_object(
      'shift_count', r.shift_count,
      'hourly_rate', r.hourly_rate,
      'gross_pay', r.gross_pay,
      'paid_total', v_paid,
      'due_total', v_due,
      'minutes_worked', v_minutes_worked,
      'break_minutes', v_break_minutes,
      'paid_break_minutes', v_paid_break_minutes,
      'unpaid_break_minutes', v_unpaid_break_minutes,
      'rounded_minutes', v_rounded_minutes,
      'hours_paid', v_hours_paid
    ),
    'details', coalesce(r.details, '{}'::jsonb),
    'flags', v_flags
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.range_overlaps_locked_period(_start_ts timestamp with time zone, _end_ts timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (
    select 1
    from public.pay_periods p
    where p.status = 'locked'
      and daterange(p.start_date, p.end_date, '[]')
          && daterange(
               public.ts_local_date(_start_ts, p.timezone),
               public.ts_local_date(coalesce(_end_ts, _start_ts), p.timezone),
               '[]'
             )
  );
$function$;
CREATE OR REPLACE FUNCTION public.record_contractor_payment(_payroll_run_id uuid, _employee_id uuid, _amount numeric, _method text DEFAULT 'other'::text, _reference text DEFAULT NULL::text, _note text DEFAULT NULL::text, _paid_at timestamp with time zone DEFAULT now())
 RETURNS public.contractor_payments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.payroll_runs;
  v_row public.contractor_payments;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode='42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = _payroll_run_id;

  if v_run.id is null then
    raise exception 'Payroll run not found' using errcode='22023';
  end if;

  if v_run.status <> 'final' then
    raise exception 'Payments should be recorded only for FINAL runs' using errcode='22023';
  end if;

  if _amount is null or _amount < 0 then
    raise exception 'amount must be >= 0' using errcode='22023';
  end if;

  if _method not in ('zelle','ach','wire','cash','check','other') then
    raise exception 'Invalid method' using errcode='22023';
  end if;

  insert into public.contractor_payments(
    payroll_run_id, employee_id, amount, method, reference, note, paid_at
  ) values (
    _payroll_run_id, _employee_id, _amount, _method, _reference, _note, coalesce(_paid_at, now())
  )
  returning * into v_row;

  return v_row;
end;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_monthly_hours_all()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  refresh materialized view concurrently public.mv_monthly_hours;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_monthly_hours_month(p_month_start date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- You can later optimize to only touch one month; for now we reuse the full refresh.
  perform public.refresh_monthly_hours_all();
end;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_payroll_period_hours()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  refresh materialized view concurrently public.mv_payroll_period_hours;
exception when feature_not_supported then
  refresh materialized view public.mv_payroll_period_hours;
end;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_weekly_hours()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  refresh materialized view concurrently public.mv_weekly_hours;
exception when feature_not_supported then
  refresh materialized view public.mv_weekly_hours;
end;
$function$;
CREATE OR REPLACE FUNCTION public.resolve_expected_window(_employee_id uuid, _ts timestamp with time zone, _store_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(expected_start_ts timestamp with time zone, expected_end_ts timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with tz_pick as (
  select coalesce(
    (select timezone from public.store_locations where id = _store_id),
    (select timezone from public.store_locations where active is true order by created_at asc limit 1),
    'America/New_York'
  ) as tz
),
d as (
  select (_ts at time zone (select tz from tz_pick))::date as work_date
),
ov as (
  select o.start_local, o.end_local
  from public.work_schedule_overrides o
  join d on o.work_date = d.work_date
  where o.employee_id = _employee_id
    and coalesce(o.off,false) = false
  order by
    (case when _store_id is not null and o.store_id = _store_id then 0 else 1 end),
    o.created_at desc
  limit 1
),
rec as (
  select r.start_local, r.end_local
  from public.work_schedules r
  join d on r.weekday = extract(dow from d.work_date)
  where r.employee_id = _employee_id
    and r.active = true
    and r.effective_from <= d.work_date
    and (r.effective_to is null or r.effective_to >= d.work_date)
  order by
    (case when _store_id is not null and r.store_id = _store_id then 0 else 1 end),
    r.effective_from desc
  limit 1
),
chosen as (
  -- prefer override if it has both times; else recurring
  select
    case when ov.start_local is not null and ov.end_local is not null then ov.start_local else rec.start_local end as s_local,
    case when ov.start_local is not null and ov.end_local is not null then ov.end_local   else rec.end_local   end as e_local,
    (select tz from tz_pick) as tz,
    (select work_date from d) as wdate
  from ov
  full join rec on true
),
built as (
  select
    case when s_local is null or e_local is null then null
         else make_timestamptz(extract(year from wdate)::int, extract(month from wdate)::int, extract(day from wdate)::int,
                                extract(hour from s_local)::int, extract(minute from s_local)::int, 0, tz)
    end as start_ts,
    case when s_local is null or e_local is null then null
         else make_timestamptz(extract(year from wdate)::int, extract(month from wdate)::int, extract(day from wdate)::int,
                                extract(hour from e_local)::int, extract(minute from e_local)::int, 0, tz)
    end as end_ts
  from chosen
)
select
  start_ts                                                      as expected_start_ts,
  case when start_ts is not null and end_ts is not null and end_ts <= start_ts
       then end_ts + interval '24 hours'
       else end_ts
  end                                                          as expected_end_ts
from built;
$function$;
CREATE OR REPLACE FUNCTION public.resolve_hourly_rate(_employee_id uuid, _work_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    coalesce(
      (
        select r.hourly_rate
        from public.employee_rates r
        where r.employee_id = _employee_id
          and r.effective_from <= _work_date
          and (r.effective_to is null or r.effective_to >= _work_date)
        order by r.effective_from desc, r.created_at desc
        limit 1
      ),
      (select e.hourly_rate from public.employees e where e.id = _employee_id)
    ) as hourly_rate;
$function$;
CREATE OR REPLACE FUNCTION public.round_seconds(_seconds bigint, _mode text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_step int;
  v_s bigint := greatest(coalesce(_seconds,0),0);
begin
  if _mode is null or _mode = '' or _mode = 'none' then
    return v_s;
  end if;

  if _mode = 'nearest_15' then
    v_step := 15*60;
  elsif _mode = 'nearest_5' then
    v_step := 5*60;
  else
    raise exception 'Invalid rounding_mode: %', _mode using errcode='22023';
  end if;

  -- nearest step (half-up)
  return ((v_s + (v_step/2)) / v_step) * v_step;
end;
$function$;
CREATE OR REPLACE FUNCTION public.round_up_to_increment(p numeric, inc numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when inc is null or inc <= 0 then p
    else ceil(p / inc) * inc
  end;
$function$;
CREATE OR REPLACE FUNCTION public.rpc_storefront_catalog(p_channel_id text DEFAULT 'og_main'::text)
 RETURNS TABLE(channel_id text, item_type_id uuid, title text, description text, display_price numeric, pricing_mode text, badge_flags text[], photo_keys text[], categories text[], qr_type text, weight_g numeric, stock_label text, remaining_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select
      l.channel_id,
      l.sort_rank, -- ✅ FIX: include sort_rank so ORDER BY works
      it.id as item_type_id,

      -- text fallbacks
      coalesce(nullif(l.public_title, ''), it.title) as title,
      coalesce(nullif(l.public_description, ''), it.description) as description,

      -- photo selection: listing keys if provided, else item_types.photos
      case
        when array_length(l.public_photo_keys, 1) is not null
         and array_length(l.public_photo_keys, 1) > 0
          then l.public_photo_keys
        else it.photos
      end as photo_keys,

      it.categories::text[] as categories,
      it.qr_type,
      it.weight as weight_g,

      l.pricing_mode,
      l.public_price_override,
      it.sale_price,

      l.metal,
      l.purity_basis_points,
      l.premium_basis_points,
      l.labor_fee,
      l.rounding_increment,

      l.badge_flags,

      -- total stock from central truth
      coalesce(s.qty, 0) as qty
    from public.storefront_listings l
    join public.sales_channels c
      on c.id = l.channel_id
     and c.active = true
    join public.item_types it
      on it.id = l.item_type_id
    left join lateral (
      select sum(isl.quantity)::int as qty
      from public.item_stock_locations isl
      where isl.item_id = it.id
    ) s on true
    where l.published = true
      and l.channel_id = p_channel_id
  ),
  priced as (
    select
      b.*,
      case
        when b.pricing_mode = 'metal_spot' then (
          public.round_up_to_increment(
            (
              (sp.price_per_gram * b.weight_g)
              * (coalesce(b.purity_basis_points, 10000)::numeric / 10000)
              * (1 + (coalesce(b.premium_basis_points, 0)::numeric / 10000))
              + coalesce(b.labor_fee, 0)
            ),
            coalesce(b.rounding_increment, 1)
          )
        )
        else coalesce(b.public_price_override, b.sale_price)
      end as display_price
    from base b
    left join public.metal_spot_prices sp
      on sp.metal = b.metal
  )
  select
    channel_id,
    item_type_id,
    title,
    description,
    display_price,
    pricing_mode,
    badge_flags,
    photo_keys,
    categories,
    qr_type,
    weight_g,
    case
      when qty <= 0 then 'Sold out'
      when qty <= 3 then 'Only ' || qty::text || ' left'
      when qty <= 10 then 'Low stock'
      else 'In stock'
    end as stock_label,
    case when qty between 1 and 3 then qty else null end as remaining_count
  from priced
  order by sort_rank asc nulls last, title asc;
$function$;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.sms_outbox_claim(_batch integer DEFAULT 25)
 RETURNS SETOF public.sms_outbox
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.sms_outbox o
  set status = 'sending', attempts = o.attempts + 1
  where o.id in (
    select id
    from public.sms_outbox
    where status = 'pending'
      and send_after <= now()
    order by send_after asc
    limit _batch
    for update skip locked
  )
  returning o.*;
$function$;
CREATE OR REPLACE FUNCTION public.start_break_now_geo(_employee_id uuid, _lat numeric, _lng numeric, _accuracy_m numeric, _photo_path text, _store_id uuid DEFAULT NULL::uuid)
 RETURNS public.time_breaks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_emp_user uuid;

  v_accuracy_max numeric := 500;
  v_entry_id uuid;
  v_shift_store_id uuid;

  v_shift_store record;
  v_day date;

  v_emp_exc record;
  v_store_exc record;

  v_any_store boolean := false;
  v_target_store_id uuid;

  v_store record;
  v_distance numeric;

  v_break public.time_breaks;
  v_now timestamptz := now();
begin
  -- BLOCK if pay period locked
  perform public.assert_unlocked_for_ts(v_now, 'start break');

  if coalesce(trim(_photo_path),'') = '' then
    raise exception 'Photo required' using errcode='22023';
  end if;

  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then raise exception 'Employee not found'; end if;
  if v_emp_user <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;

  if _store_id is not null and not public.is_admin() then
    raise exception 'Not allowed to choose store';
  end if;

  v_entry_id := public.get_open_shift_id(_employee_id);
  if v_entry_id is null then
    raise exception 'No open shift to start a break';
  end if;

  select t.store_id into v_shift_store_id
  from public.time_entries t
  where t.id = v_entry_id;

  if v_shift_store_id is null then
    raise exception 'Shift has no store assignment; cannot start break';
  end if;

  select * into v_shift_store
  from public.store_locations s
  where s.id = v_shift_store_id;

  if v_shift_store is null or v_shift_store.active is not true then
    raise exception 'Shift store is not active or not configured';
  end if;

  v_day := (v_now at time zone v_shift_store.timezone)::date;

  if exists (
    select 1
    from public.time_breaks b
    where b.time_entry_id = v_entry_id
      and b.ended_at is null
  ) then
    raise exception 'A break is already in progress';
  end if;

  select * into v_emp_exc
  from public.timeclock_day_exceptions x
  where x.employee_id = _employee_id
    and x.work_date = v_day
  limit 1;

  select * into v_store_exc
  from public.timeclock_store_exceptions sx
  where sx.store_id = v_shift_store_id
    and sx.work_date = v_day
  limit 1;

  v_any_store :=
    coalesce(v_emp_exc.allow_clock_in_any_store,false)
    or coalesce(v_emp_exc.allow_clock_out_any_store,false)
    or coalesce(v_store_exc.allow_clock_in_any_store,false)
    or coalesce(v_store_exc.allow_clock_out_any_store,false);

  if _store_id is not null then
    v_target_store_id := _store_id;

    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id
      and s.active is true;

    if v_store is null then
      raise exception 'Selected store is not active';
    end if;

    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);

  elsif v_any_store then
    select s.*, q.distance_m
    into v_store
    from (
      select s.id,
             public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      from public.store_locations s
      where s.active is true
    ) q
    join public.store_locations s on s.id = q.id
    where q.distance_m <= s.radius_m
    order by q.distance_m asc
    limit 1;

    if v_store is null then
      raise exception 'Break allowed at any store today, but you are not inside any active store geofence';
    end if;

    v_distance := v_store.distance_m;

  else
    v_target_store_id :=
      coalesce(
        v_emp_exc.clock_in_store_id,
        v_emp_exc.clock_out_store_id,
        v_store_exc.clock_in_store_id,
        v_store_exc.clock_out_store_id,
        v_shift_store_id
      );

    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id
      and s.active is true;

    if v_store is null then
      raise exception 'No active store configured for break enforcement';
    end if;

    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then _accuracy_m := 9999; end if;

  if v_distance > v_store.radius_m or _accuracy_m > v_accuracy_max then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)',
      round(v_distance,1), round(_accuracy_m,1);
  end if;

  insert into public.time_breaks (
    time_entry_id, started_at,
    start_lat, start_lng, start_accuracy_m,
    geo_ok_start, photo_start_path
  ) values (
    v_entry_id, v_now,
    _lat, _lng, _accuracy_m,
    true, _photo_path
  )
  returning * into v_break;

  return v_break;
end;
$function$;
CREATE OR REPLACE FUNCTION public.subtract_quantity(loc_id uuid, delta integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$begin
  update item_stock_locations
  set quantity = quantity - delta
  where id = loc_id;
end;$function$;
CREATE OR REPLACE FUNCTION public.sync_batch_qty_from_stock()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.batch_id IS NOT NULL THEN
    UPDATE public.bulk_batches b
       SET qty_remaining = NEW.quantity,
           status = CASE
                      WHEN NEW.quantity <= 0 THEN 'closed'
                      WHEN b.low_threshold IS NOT NULL AND NEW.quantity <= b.low_threshold
                        THEN 'low'
                      WHEN b.low_threshold IS NULL AND NEW.quantity <= GREATEST(1, (b.initial_qty/10)::int)
                        THEN 'low'
                      ELSE 'open'
                    END,
           retired_at = CASE WHEN NEW.quantity <= 0 THEN now() ELSE retired_at END
     WHERE b.id = NEW.batch_id;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.sync_shift_anomalies(_time_entry_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  update public.time_entries t
  set schedule_codes = v.anomalies
  from public.v_shift_anomalies v
  where v.time_entry_id = t.id
    and ( _time_entry_id is null or t.id = _time_entry_id )
    and coalesce(t.schedule_codes, '{}'::text[]) = '{}'::text[];

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.tr_time_breaks_ai()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.notify_break_started(new.id);
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.tr_time_breaks_au()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.ended_at is null and new.ended_at is not null then
    perform public.notify_break_ended(new.id);
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.tr_time_entries_alert_ai()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.notify_shift_flags(new.id);
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.tr_time_entries_alert_au()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (old.clock_out is null and new.clock_out is not null) or new.schedule_codes is distinct from old.schedule_codes then
    perform public.notify_shift_flags(new.id);
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.ts_local_date(_ts timestamp with time zone, _tz text)
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$
  select (_ts at time zone coalesce(nullif(_tz,''), 'America/New_York'))::date;
$function$;
CREATE OR REPLACE FUNCTION public.ts_overlaps_locked_period(_ts timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select public.range_overlaps_locked_period(_ts, _ts);
$function$;
CREATE OR REPLACE FUNCTION public.unapprove_shift(_time_entry_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid;
  v_role text;
  v_clock_in timestamptz;
  v_work_date date;
  v_locked boolean := false;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  -- Role check (your roles are in public.employees)
  select e.role into v_role
  from public.employees e
  where e.user_id = v_user;

  if coalesce(v_role,'') not in ('admin','manager') then
    raise exception 'Not authorized';
  end if;

  -- Get shift date (use America/New_York since your system is NY-based)
  select t.clock_in into v_clock_in
  from public.time_entries t
  where t.id = _time_entry_id;

  if v_clock_in is null then
    raise exception 'Time entry not found';
  end if;

  v_work_date := (v_clock_in at time zone 'America/New_York')::date;

  -- Block if in locked pay period
  select exists (
    select 1
    from public.pay_periods p
    where v_work_date between p.start_date and p.end_date
      and lower(p.status) = 'locked'
  ) into v_locked;

  if v_locked then
    raise exception 'Shift is in a locked pay period';
  end if;

  -- Delete approval/waiver row (back to "pending" by absence)
  delete from public.shift_approvals sa
  where sa.time_entry_id = _time_entry_id;

end;
$function$;
CREATE OR REPLACE FUNCTION public.update_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
create or replace view "public"."v_monthly_hours" as  SELECT e.id AS employee_id,
    e.display_name,
    (date_trunc('month'::text, (t.clock_in AT TIME ZONE 'America/New_York'::text)))::date AS month_start,
    count(*) AS shifts_count,
    round((sum(EXTRACT(epoch FROM (t.clock_out - t.clock_in))) / 3600.0), 2) AS total_hours
   FROM (public.time_entries t
     JOIN public.employees e ON ((e.id = t.employee_id)))
  WHERE (t.clock_out IS NOT NULL)
  GROUP BY e.id, e.display_name, ((date_trunc('month'::text, (t.clock_in AT TIME ZONE 'America/New_York'::text)))::date);
create or replace view "public"."v_shift_adjustments" as  SELECT sa.id,
    sa.time_entry_id,
    sa.editor_user_id,
    COALESCE(e.display_name, (u.email)::text) AS editor_name,
    sa.edited_at,
    sa.reason,
    sa.fields_changed,
    sa.old_value,
    sa.new_value
   FROM ((public.shift_adjustments sa
     LEFT JOIN public.employees e ON ((e.user_id = sa.editor_user_id)))
     LEFT JOIN auth.users u ON ((u.id = sa.editor_user_id)));
create or replace view "public"."v_shift_anomalies" as  WITH base AS (
         SELECT t.id AS time_entry_id,
            t.employee_id,
            e.display_name,
            t.store_id,
            t.clock_in,
            t.clock_out
           FROM (public.time_entries t
             JOIN public.employees e ON ((e.id = t.employee_id)))
        ), win AS (
         SELECT b_1.time_entry_id,
            (l.w).expected_start_ts AS expected_start_ts,
            (l.w).expected_end_ts AS expected_end_ts
           FROM (base b_1
             LEFT JOIN LATERAL ( SELECT public.resolve_expected_window(b_1.employee_id, b_1.clock_in, b_1.store_id) AS w) l ON (true))
        ), cfg AS (
         SELECT b_1.time_entry_id,
            COALESCE(s.schedule_grace_in_m, 5) AS g_in,
            COALESCE(s.schedule_grace_out_m, 5) AS g_out
           FROM (base b_1
             LEFT JOIN public.store_locations s ON ((s.id = b_1.store_id)))
        )
 SELECT b.time_entry_id,
    b.employee_id,
    b.display_name,
    b.clock_in,
    b.clock_out,
    w.expected_start_ts,
    w.expected_end_ts,
    COALESCE(array_remove(ARRAY[
        CASE
            WHEN (w.expected_start_ts IS NULL) THEN 'UNSCHEDULED_DAY'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((w.expected_start_ts IS NOT NULL) AND (b.clock_in < (w.expected_start_ts - ((c.g_in || ' minutes'::text))::interval))) THEN 'EARLY_CLOCK_IN'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((w.expected_start_ts IS NOT NULL) AND (b.clock_in > (w.expected_start_ts + ((c.g_in || ' minutes'::text))::interval))) THEN 'LATE_CLOCK_IN'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((w.expected_end_ts IS NOT NULL) AND (b.clock_out IS NOT NULL) AND (b.clock_out < (w.expected_end_ts - ((c.g_out || ' minutes'::text))::interval))) THEN 'EARLY_CLOCK_OUT'::text
            ELSE NULL::text
        END,
        CASE
            WHEN ((w.expected_end_ts IS NOT NULL) AND (b.clock_out IS NOT NULL) AND (b.clock_out > (w.expected_end_ts + ((c.g_out || ' minutes'::text))::interval))) THEN 'LATE_CLOCK_OUT'::text
            ELSE NULL::text
        END], NULL::text), '{}'::text[]) AS anomalies,
        CASE
            WHEN (w.expected_start_ts IS NULL) THEN true
            WHEN (b.clock_in < (w.expected_start_ts - ((c.g_in || ' minutes'::text))::interval)) THEN true
            WHEN (b.clock_in > (w.expected_start_ts + ((c.g_in || ' minutes'::text))::interval)) THEN true
            WHEN ((w.expected_end_ts IS NOT NULL) AND (b.clock_out IS NOT NULL) AND ((b.clock_out < (w.expected_end_ts - ((c.g_out || ' minutes'::text))::interval)) OR (b.clock_out > (w.expected_end_ts + ((c.g_out || ' minutes'::text))::interval)))) THEN true
            ELSE false
        END AS has_anomaly,
    sa.status AS approval_status,
    sa.note AS approval_note,
    sa.approved_at
   FROM (((base b
     LEFT JOIN win w ON ((w.time_entry_id = b.time_entry_id)))
     LEFT JOIN cfg c ON ((c.time_entry_id = b.time_entry_id)))
     LEFT JOIN public.shift_approvals sa ON ((sa.time_entry_id = b.time_entry_id)));
CREATE OR REPLACE FUNCTION public.week_start(ts timestamp with time zone, tz text DEFAULT public.org_timezone(), week_start_dow integer DEFAULT public.org_week_start_dow())
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
AS $function$
  select
    (
      date_trunc('day', timezone(tz, ts))::timestamp
      - make_interval(days => ((extract(dow from timezone(tz, ts))::int - week_start_dow + 7) % 7))
    ) at time zone tz
$function$;
create materialized view "public"."mv_weekly_hours" as  WITH closed_shifts AS (
         SELECT t.id AS time_entry_id,
            t.employee_id,
            t.clock_in,
            t.clock_out
           FROM public.time_entries t
          WHERE (t.clock_out IS NOT NULL)
        ), shift_weeks AS (
         SELECT s.time_entry_id,
            s.employee_id,
            ws.week_start,
            ws.week_end
           FROM (closed_shifts s
             CROSS JOIN LATERAL ( WITH bounds AS (
                         SELECT public.week_start(s.clock_in, public.org_timezone(), public.org_week_start_dow()) AS wk0,
                            public.week_start(s.clock_out, public.org_timezone(), public.org_week_start_dow()) AS wk1
                        )
                 SELECT wk.wk AS week_start,
                    (wk.wk + '7 days'::interval) AS week_end
                   FROM bounds,
                    LATERAL generate_series(bounds.wk0, bounds.wk1, '7 days'::interval) wk(wk)) ws)
        ), weekly_overlap AS (
         SELECT sw.employee_id,
            ((sw.week_start AT TIME ZONE public.org_timezone()))::date AS week_start_date,
            GREATEST(s.clock_in, sw.week_start) AS seg_start,
            LEAST(s.clock_out, sw.week_end) AS seg_end
           FROM (shift_weeks sw
             JOIN closed_shifts s ON ((s.time_entry_id = sw.time_entry_id)))
          WHERE (LEAST(s.clock_out, sw.week_end) > GREATEST(s.clock_in, sw.week_start))
        )
 SELECT weekly_overlap.employee_id,
    weekly_overlap.week_start_date,
    (sum(EXTRACT(epoch FROM (weekly_overlap.seg_end - weekly_overlap.seg_start))))::bigint AS work_seconds,
    (sum(EXTRACT(epoch FROM (weekly_overlap.seg_end - weekly_overlap.seg_start))) / 3600.0) AS work_hours
   FROM weekly_overlap
  GROUP BY weekly_overlap.employee_id, weekly_overlap.week_start_date;
create or replace view "public"."v_payroll_period_hours" as  WITH cfg AS (
         SELECT public.org_timezone() AS tz,
            public.org_week_start_dow() AS wdow
        ), periods AS (
         SELECT p_1.id AS period_id,
            p_1.start_date,
            p_1.end_date,
            p_1.timezone,
            p_1.status,
            make_timestamptz((EXTRACT(year FROM p_1.start_date))::integer, (EXTRACT(month FROM p_1.start_date))::integer, (EXTRACT(day FROM p_1.start_date))::integer, 0, 0, (0)::double precision, p_1.timezone) AS p_start,
            make_timestamptz((EXTRACT(year FROM (p_1.end_date + 1)))::integer, (EXTRACT(month FROM (p_1.end_date + 1)))::integer, (EXTRACT(day FROM (p_1.end_date + 1)))::integer, 0, 0, (0)::double precision, p_1.timezone) AS p_end
           FROM public.pay_periods p_1
        ), base AS (
         SELECT te.id AS time_entry_id,
            te.employee_id,
            te.clock_in,
            te.clock_out,
            pr.period_id,
            pr.start_date,
            pr.end_date,
            pr.timezone,
            pr.status,
            pr.p_start,
            pr.p_end
           FROM (public.time_entries te
             JOIN periods pr ON (((te.clock_out IS NOT NULL) AND (te.clock_in < pr.p_end) AND (te.clock_out > pr.p_start))))
        ), clipped AS (
         SELECT base.employee_id,
            base.period_id,
            base.start_date,
            base.end_date,
            base.timezone,
            base.status,
            GREATEST(base.clock_in, base.p_start) AS s_start,
            LEAST(base.clock_out, base.p_end) AS s_end
           FROM base
        ), seg1 AS (
         SELECT c.employee_id,
            c.period_id,
            c.start_date,
            c.end_date,
            c.timezone,
            c.status,
            public.week_start(c.s_start, cfg.tz, cfg.wdow) AS wk_start,
            public.next_week_start(c.s_start, cfg.tz, cfg.wdow) AS wk_next,
            GREATEST(c.s_start, public.week_start(c.s_start, cfg.tz, cfg.wdow)) AS ss,
            LEAST(c.s_end, public.next_week_start(c.s_start, cfg.tz, cfg.wdow)) AS ee
           FROM clipped c,
            cfg
        ), seg2 AS (
         SELECT c.employee_id,
            c.period_id,
            c.start_date,
            c.end_date,
            c.timezone,
            c.status,
            public.week_start((c.s_end - '00:00:01'::interval), cfg.tz, cfg.wdow) AS wk_start,
            public.next_week_start((c.s_end - '00:00:01'::interval), cfg.tz, cfg.wdow) AS wk_next,
            GREATEST(c.s_start, public.week_start((c.s_end - '00:00:01'::interval), cfg.tz, cfg.wdow)) AS ss,
            c.s_end AS ee
           FROM clipped c,
            cfg
          WHERE (public.week_start(c.s_start, cfg.tz, cfg.wdow) <> public.week_start((c.s_end - '00:00:01'::interval), cfg.tz, cfg.wdow))
        ), segments AS (
         SELECT seg1.employee_id,
            seg1.period_id,
            seg1.start_date,
            seg1.end_date,
            seg1.timezone,
            seg1.status,
            seg1.wk_start,
            seg1.wk_next,
            seg1.ss,
            seg1.ee
           FROM seg1
        UNION ALL
         SELECT seg2.employee_id,
            seg2.period_id,
            seg2.start_date,
            seg2.end_date,
            seg2.timezone,
            seg2.status,
            seg2.wk_start,
            seg2.wk_next,
            seg2.ss,
            seg2.ee
           FROM seg2
        ), norm AS (
         SELECT segments.employee_id,
            segments.period_id,
            segments.start_date,
            segments.end_date,
            segments.timezone,
            segments.status,
            ((segments.wk_start AT TIME ZONE public.org_timezone()))::date AS week_start,
            (GREATEST((0)::numeric, EXTRACT(epoch FROM (segments.ee - segments.ss))) / 3600.0) AS hours
           FROM segments
          WHERE (segments.ee > segments.ss)
        ), weekly_emp AS (
         SELECT norm.employee_id,
            norm.period_id,
            norm.start_date,
            norm.end_date,
            norm.timezone,
            norm.status,
            norm.week_start,
            sum(norm.hours) AS week_hours
           FROM norm
          GROUP BY norm.employee_id, norm.period_id, norm.start_date, norm.end_date, norm.timezone, norm.status, norm.week_start
        ), per_emp AS (
         SELECT w.employee_id,
            w.period_id,
            min(w.start_date) AS start_date,
            min(w.end_date) AS end_date,
            min(w.timezone) AS timezone,
            min(w.status) AS status,
            (sum(LEAST(40.0, w.week_hours)))::numeric(10,2) AS regular_hours,
            (sum(GREATEST(0.0, (w.week_hours - 40.0))))::numeric(10,2) AS overtime_hours,
            (sum(w.week_hours))::numeric(10,2) AS total_hours
           FROM weekly_emp w
          GROUP BY w.employee_id, w.period_id
        ), shift_counts AS (
         SELECT pr.id AS period_id,
            te.employee_id,
            (count(*))::integer AS shifts_count
           FROM (public.pay_periods pr
             JOIN public.time_entries te ON (((te.clock_out IS NOT NULL) AND (te.clock_in < make_timestamptz((EXTRACT(year FROM (pr.end_date + 1)))::integer, (EXTRACT(month FROM (pr.end_date + 1)))::integer, (EXTRACT(day FROM (pr.end_date + 1)))::integer, 0, 0, (0)::double precision, pr.timezone)) AND (te.clock_out > make_timestamptz((EXTRACT(year FROM pr.start_date))::integer, (EXTRACT(month FROM pr.start_date))::integer, (EXTRACT(day FROM pr.start_date))::integer, 0, 0, (0)::double precision, pr.timezone)))))
          GROUP BY pr.id, te.employee_id
        )
 SELECT p.period_id,
    p.start_date,
    p.end_date,
    p.timezone,
    p.status,
    p.employee_id,
    e.display_name,
    COALESCE(sc.shifts_count, 0) AS shifts_count,
    p.regular_hours,
    p.overtime_hours,
    p.total_hours
   FROM ((per_emp p
     JOIN public.employees e ON ((e.id = p.employee_id)))
     LEFT JOIN shift_counts sc ON (((sc.period_id = p.period_id) AND (sc.employee_id = p.employee_id))))
  ORDER BY p.start_date DESC, e.display_name;
create or replace view "public"."v_weekly_hours" as  WITH cfg AS (
         SELECT public.org_timezone() AS tz,
            public.org_week_start_dow() AS wdow
        ), base AS (
         SELECT t.id,
            t.employee_id,
            t.clock_in,
            t.clock_out
           FROM public.time_entries t
          WHERE (t.clock_out IS NOT NULL)
        ), seg1 AS (
         SELECT b.employee_id,
            public.week_start(b.clock_in, cfg.tz, cfg.wdow) AS wk_start,
            public.next_week_start(b.clock_in, cfg.tz, cfg.wdow) AS wk_next,
            GREATEST(b.clock_in, public.week_start(b.clock_in, cfg.tz, cfg.wdow)) AS s_start,
            LEAST(b.clock_out, public.next_week_start(b.clock_in, cfg.tz, cfg.wdow)) AS s_end
           FROM base b,
            cfg
        ), seg2 AS (
         SELECT b.employee_id,
            public.week_start((b.clock_out - '00:00:01'::interval), cfg.tz, cfg.wdow) AS wk_start,
            public.next_week_start((b.clock_out - '00:00:01'::interval), cfg.tz, cfg.wdow) AS wk_next,
            GREATEST(b.clock_in, public.week_start((b.clock_out - '00:00:01'::interval), cfg.tz, cfg.wdow)) AS s_start,
            b.clock_out AS s_end
           FROM base b,
            cfg
          WHERE (public.week_start(b.clock_in, cfg.tz, cfg.wdow) <> public.week_start((b.clock_out - '00:00:01'::interval), cfg.tz, cfg.wdow))
        ), segments AS (
         SELECT seg1.employee_id,
            seg1.wk_start,
            seg1.s_start,
            seg1.s_end
           FROM seg1
        UNION ALL
         SELECT seg2.employee_id,
            seg2.wk_start,
            seg2.s_start,
            seg2.s_end
           FROM seg2
        ), segments_norm AS (
         SELECT s.employee_id,
            ((s.wk_start AT TIME ZONE public.org_timezone()))::date AS week_start,
            (GREATEST((0)::numeric, EXTRACT(epoch FROM (s.s_end - s.s_start))) / 3600.0) AS hours
           FROM segments s
          WHERE (s.s_end > s.s_start)
        ), weekly AS (
         SELECT segments_norm.employee_id,
            segments_norm.week_start,
            sum(segments_norm.hours) AS total_hours
           FROM segments_norm
          GROUP BY segments_norm.employee_id, segments_norm.week_start
        )
 SELECT w.employee_id,
    e.display_name,
    w.week_start,
    (LEAST(40.0, w.total_hours))::numeric(10,2) AS regular_hours,
    (GREATEST(0.0, (w.total_hours - 40.0)))::numeric(10,2) AS overtime_hours,
    (w.total_hours)::numeric(10,2) AS total_hours
   FROM (weekly w
     JOIN public.employees e ON ((e.id = w.employee_id)))
  ORDER BY w.week_start, e.display_name;
create materialized view "public"."mv_payroll_period_hours" as  WITH weeks AS (
         SELECT w.employee_id,
            w.week_start_date,
            w.work_hours,
            LEAST(w.work_hours, 40.0) AS regular_hours,
            GREATEST((w.work_hours - 40.0), 0.0) AS overtime_hours
           FROM public.mv_weekly_hours w
        ), period_weeks AS (
         SELECT p.id AS pay_period_id,
            p.start_date,
            p.end_date,
            p.status,
            p.timezone,
            w.employee_id,
            w.week_start_date,
            w.work_hours,
            w.regular_hours,
            w.overtime_hours
           FROM (public.pay_periods p
             JOIN weeks w ON (((w.week_start_date >= p.start_date) AND (w.week_start_date <= p.end_date))))
        )
 SELECT pw.pay_period_id,
    pw.start_date,
    pw.end_date,
    pw.status,
    pw.timezone,
    pw.employee_id,
    e.display_name,
    COALESCE(e.hourly_rate, (0)::numeric) AS hourly_rate,
    sum(pw.work_hours) AS hours,
    sum(pw.regular_hours) AS regular_hours,
    sum(pw.overtime_hours) AS overtime_hours,
    ((sum(pw.regular_hours) * COALESCE(e.hourly_rate, (0)::numeric)) + ((sum(pw.overtime_hours) * COALESCE(e.hourly_rate, (0)::numeric)) * 1.5)) AS amount
   FROM (period_weeks pw
     JOIN public.employees e ON ((e.id = pw.employee_id)))
  GROUP BY pw.pay_period_id, pw.start_date, pw.end_date, pw.status, pw.timezone, pw.employee_id, e.display_name, e.hourly_rate;
CREATE INDEX mv_monthly_hours_name ON public.mv_monthly_hours USING btree (display_name);
CREATE UNIQUE INDEX mv_monthly_hours_unique ON public.mv_monthly_hours USING btree (employee_id, month_start);
CREATE INDEX mv_payroll_period_hours_period_idx ON public.mv_payroll_period_hours USING btree (pay_period_id);
CREATE INDEX mv_weekly_hours_employee_week_idx ON public.mv_weekly_hours USING btree (employee_id, week_start_date);
grant delete on table "public"."agreement_versions" to "anon";
grant insert on table "public"."agreement_versions" to "anon";
grant references on table "public"."agreement_versions" to "anon";
grant select on table "public"."agreement_versions" to "anon";
grant trigger on table "public"."agreement_versions" to "anon";
grant truncate on table "public"."agreement_versions" to "anon";
grant update on table "public"."agreement_versions" to "anon";
grant delete on table "public"."agreement_versions" to "authenticated";
grant insert on table "public"."agreement_versions" to "authenticated";
grant references on table "public"."agreement_versions" to "authenticated";
grant select on table "public"."agreement_versions" to "authenticated";
grant trigger on table "public"."agreement_versions" to "authenticated";
grant truncate on table "public"."agreement_versions" to "authenticated";
grant update on table "public"."agreement_versions" to "authenticated";
grant delete on table "public"."agreement_versions" to "service_role";
grant insert on table "public"."agreement_versions" to "service_role";
grant references on table "public"."agreement_versions" to "service_role";
grant select on table "public"."agreement_versions" to "service_role";
grant trigger on table "public"."agreement_versions" to "service_role";
grant truncate on table "public"."agreement_versions" to "service_role";
grant update on table "public"."agreement_versions" to "service_role";
grant delete on table "public"."batch_confirmations" to "anon";
grant insert on table "public"."batch_confirmations" to "anon";
grant references on table "public"."batch_confirmations" to "anon";
grant select on table "public"."batch_confirmations" to "anon";
grant trigger on table "public"."batch_confirmations" to "anon";
grant truncate on table "public"."batch_confirmations" to "anon";
grant update on table "public"."batch_confirmations" to "anon";
grant delete on table "public"."batch_confirmations" to "authenticated";
grant insert on table "public"."batch_confirmations" to "authenticated";
grant references on table "public"."batch_confirmations" to "authenticated";
grant select on table "public"."batch_confirmations" to "authenticated";
grant trigger on table "public"."batch_confirmations" to "authenticated";
grant truncate on table "public"."batch_confirmations" to "authenticated";
grant update on table "public"."batch_confirmations" to "authenticated";
grant delete on table "public"."batch_confirmations" to "service_role";
grant insert on table "public"."batch_confirmations" to "service_role";
grant references on table "public"."batch_confirmations" to "service_role";
grant select on table "public"."batch_confirmations" to "service_role";
grant trigger on table "public"."batch_confirmations" to "service_role";
grant truncate on table "public"."batch_confirmations" to "service_role";
grant update on table "public"."batch_confirmations" to "service_role";
grant delete on table "public"."bulk_batches" to "anon";
grant insert on table "public"."bulk_batches" to "anon";
grant references on table "public"."bulk_batches" to "anon";
grant select on table "public"."bulk_batches" to "anon";
grant trigger on table "public"."bulk_batches" to "anon";
grant truncate on table "public"."bulk_batches" to "anon";
grant update on table "public"."bulk_batches" to "anon";
grant delete on table "public"."bulk_batches" to "authenticated";
grant insert on table "public"."bulk_batches" to "authenticated";
grant references on table "public"."bulk_batches" to "authenticated";
grant select on table "public"."bulk_batches" to "authenticated";
grant trigger on table "public"."bulk_batches" to "authenticated";
grant truncate on table "public"."bulk_batches" to "authenticated";
grant update on table "public"."bulk_batches" to "authenticated";
grant delete on table "public"."bulk_batches" to "service_role";
grant insert on table "public"."bulk_batches" to "service_role";
grant references on table "public"."bulk_batches" to "service_role";
grant select on table "public"."bulk_batches" to "service_role";
grant trigger on table "public"."bulk_batches" to "service_role";
grant truncate on table "public"."bulk_batches" to "service_role";
grant update on table "public"."bulk_batches" to "service_role";
grant delete on table "public"."contractor_agreements" to "anon";
grant insert on table "public"."contractor_agreements" to "anon";
grant references on table "public"."contractor_agreements" to "anon";
grant select on table "public"."contractor_agreements" to "anon";
grant trigger on table "public"."contractor_agreements" to "anon";
grant truncate on table "public"."contractor_agreements" to "anon";
grant update on table "public"."contractor_agreements" to "anon";
grant delete on table "public"."contractor_agreements" to "authenticated";
grant insert on table "public"."contractor_agreements" to "authenticated";
grant references on table "public"."contractor_agreements" to "authenticated";
grant select on table "public"."contractor_agreements" to "authenticated";
grant trigger on table "public"."contractor_agreements" to "authenticated";
grant truncate on table "public"."contractor_agreements" to "authenticated";
grant update on table "public"."contractor_agreements" to "authenticated";
grant delete on table "public"."contractor_agreements" to "service_role";
grant insert on table "public"."contractor_agreements" to "service_role";
grant references on table "public"."contractor_agreements" to "service_role";
grant select on table "public"."contractor_agreements" to "service_role";
grant trigger on table "public"."contractor_agreements" to "service_role";
grant truncate on table "public"."contractor_agreements" to "service_role";
grant update on table "public"."contractor_agreements" to "service_role";
grant delete on table "public"."contractor_payments" to "anon";
grant insert on table "public"."contractor_payments" to "anon";
grant references on table "public"."contractor_payments" to "anon";
grant select on table "public"."contractor_payments" to "anon";
grant trigger on table "public"."contractor_payments" to "anon";
grant truncate on table "public"."contractor_payments" to "anon";
grant update on table "public"."contractor_payments" to "anon";
grant delete on table "public"."contractor_payments" to "authenticated";
grant insert on table "public"."contractor_payments" to "authenticated";
grant references on table "public"."contractor_payments" to "authenticated";
grant select on table "public"."contractor_payments" to "authenticated";
grant trigger on table "public"."contractor_payments" to "authenticated";
grant truncate on table "public"."contractor_payments" to "authenticated";
grant update on table "public"."contractor_payments" to "authenticated";
grant delete on table "public"."contractor_payments" to "service_role";
grant insert on table "public"."contractor_payments" to "service_role";
grant references on table "public"."contractor_payments" to "service_role";
grant select on table "public"."contractor_payments" to "service_role";
grant trigger on table "public"."contractor_payments" to "service_role";
grant truncate on table "public"."contractor_payments" to "service_role";
grant update on table "public"."contractor_payments" to "service_role";
grant delete on table "public"."credit_tiers" to "anon";
grant insert on table "public"."credit_tiers" to "anon";
grant references on table "public"."credit_tiers" to "anon";
grant select on table "public"."credit_tiers" to "anon";
grant trigger on table "public"."credit_tiers" to "anon";
grant truncate on table "public"."credit_tiers" to "anon";
grant update on table "public"."credit_tiers" to "anon";
grant delete on table "public"."credit_tiers" to "authenticated";
grant insert on table "public"."credit_tiers" to "authenticated";
grant references on table "public"."credit_tiers" to "authenticated";
grant select on table "public"."credit_tiers" to "authenticated";
grant trigger on table "public"."credit_tiers" to "authenticated";
grant truncate on table "public"."credit_tiers" to "authenticated";
grant update on table "public"."credit_tiers" to "authenticated";
grant delete on table "public"."credit_tiers" to "service_role";
grant insert on table "public"."credit_tiers" to "service_role";
grant references on table "public"."credit_tiers" to "service_role";
grant select on table "public"."credit_tiers" to "service_role";
grant trigger on table "public"."credit_tiers" to "service_role";
grant truncate on table "public"."credit_tiers" to "service_role";
grant update on table "public"."credit_tiers" to "service_role";
grant delete on table "public"."deletion_log" to "anon";
grant insert on table "public"."deletion_log" to "anon";
grant references on table "public"."deletion_log" to "anon";
grant select on table "public"."deletion_log" to "anon";
grant trigger on table "public"."deletion_log" to "anon";
grant truncate on table "public"."deletion_log" to "anon";
grant update on table "public"."deletion_log" to "anon";
grant delete on table "public"."deletion_log" to "authenticated";
grant insert on table "public"."deletion_log" to "authenticated";
grant references on table "public"."deletion_log" to "authenticated";
grant select on table "public"."deletion_log" to "authenticated";
grant trigger on table "public"."deletion_log" to "authenticated";
grant truncate on table "public"."deletion_log" to "authenticated";
grant update on table "public"."deletion_log" to "authenticated";
grant delete on table "public"."deletion_log" to "service_role";
grant insert on table "public"."deletion_log" to "service_role";
grant references on table "public"."deletion_log" to "service_role";
grant select on table "public"."deletion_log" to "service_role";
grant trigger on table "public"."deletion_log" to "service_role";
grant truncate on table "public"."deletion_log" to "service_role";
grant update on table "public"."deletion_log" to "service_role";
grant delete on table "public"."employee_legal_addresses" to "anon";
grant insert on table "public"."employee_legal_addresses" to "anon";
grant references on table "public"."employee_legal_addresses" to "anon";
grant select on table "public"."employee_legal_addresses" to "anon";
grant trigger on table "public"."employee_legal_addresses" to "anon";
grant truncate on table "public"."employee_legal_addresses" to "anon";
grant update on table "public"."employee_legal_addresses" to "anon";
grant delete on table "public"."employee_legal_addresses" to "authenticated";
grant insert on table "public"."employee_legal_addresses" to "authenticated";
grant references on table "public"."employee_legal_addresses" to "authenticated";
grant select on table "public"."employee_legal_addresses" to "authenticated";
grant trigger on table "public"."employee_legal_addresses" to "authenticated";
grant truncate on table "public"."employee_legal_addresses" to "authenticated";
grant update on table "public"."employee_legal_addresses" to "authenticated";
grant delete on table "public"."employee_legal_addresses" to "service_role";
grant insert on table "public"."employee_legal_addresses" to "service_role";
grant references on table "public"."employee_legal_addresses" to "service_role";
grant select on table "public"."employee_legal_addresses" to "service_role";
grant trigger on table "public"."employee_legal_addresses" to "service_role";
grant truncate on table "public"."employee_legal_addresses" to "service_role";
grant update on table "public"."employee_legal_addresses" to "service_role";
grant delete on table "public"."employee_managers" to "anon";
grant insert on table "public"."employee_managers" to "anon";
grant references on table "public"."employee_managers" to "anon";
grant select on table "public"."employee_managers" to "anon";
grant trigger on table "public"."employee_managers" to "anon";
grant truncate on table "public"."employee_managers" to "anon";
grant update on table "public"."employee_managers" to "anon";
grant delete on table "public"."employee_managers" to "authenticated";
grant insert on table "public"."employee_managers" to "authenticated";
grant references on table "public"."employee_managers" to "authenticated";
grant select on table "public"."employee_managers" to "authenticated";
grant trigger on table "public"."employee_managers" to "authenticated";
grant truncate on table "public"."employee_managers" to "authenticated";
grant update on table "public"."employee_managers" to "authenticated";
grant delete on table "public"."employee_managers" to "service_role";
grant insert on table "public"."employee_managers" to "service_role";
grant references on table "public"."employee_managers" to "service_role";
grant select on table "public"."employee_managers" to "service_role";
grant trigger on table "public"."employee_managers" to "service_role";
grant truncate on table "public"."employee_managers" to "service_role";
grant update on table "public"."employee_managers" to "service_role";
grant delete on table "public"."employee_rates" to "anon";
grant insert on table "public"."employee_rates" to "anon";
grant references on table "public"."employee_rates" to "anon";
grant select on table "public"."employee_rates" to "anon";
grant trigger on table "public"."employee_rates" to "anon";
grant truncate on table "public"."employee_rates" to "anon";
grant update on table "public"."employee_rates" to "anon";
grant delete on table "public"."employee_rates" to "authenticated";
grant insert on table "public"."employee_rates" to "authenticated";
grant references on table "public"."employee_rates" to "authenticated";
grant select on table "public"."employee_rates" to "authenticated";
grant trigger on table "public"."employee_rates" to "authenticated";
grant truncate on table "public"."employee_rates" to "authenticated";
grant update on table "public"."employee_rates" to "authenticated";
grant delete on table "public"."employee_rates" to "service_role";
grant insert on table "public"."employee_rates" to "service_role";
grant references on table "public"."employee_rates" to "service_role";
grant select on table "public"."employee_rates" to "service_role";
grant trigger on table "public"."employee_rates" to "service_role";
grant truncate on table "public"."employee_rates" to "service_role";
grant update on table "public"."employee_rates" to "service_role";
grant delete on table "public"."employee_tax_docs" to "anon";
grant insert on table "public"."employee_tax_docs" to "anon";
grant references on table "public"."employee_tax_docs" to "anon";
grant select on table "public"."employee_tax_docs" to "anon";
grant trigger on table "public"."employee_tax_docs" to "anon";
grant truncate on table "public"."employee_tax_docs" to "anon";
grant update on table "public"."employee_tax_docs" to "anon";
grant delete on table "public"."employee_tax_docs" to "authenticated";
grant insert on table "public"."employee_tax_docs" to "authenticated";
grant references on table "public"."employee_tax_docs" to "authenticated";
grant select on table "public"."employee_tax_docs" to "authenticated";
grant trigger on table "public"."employee_tax_docs" to "authenticated";
grant truncate on table "public"."employee_tax_docs" to "authenticated";
grant update on table "public"."employee_tax_docs" to "authenticated";
grant delete on table "public"."employee_tax_docs" to "service_role";
grant insert on table "public"."employee_tax_docs" to "service_role";
grant references on table "public"."employee_tax_docs" to "service_role";
grant select on table "public"."employee_tax_docs" to "service_role";
grant trigger on table "public"."employee_tax_docs" to "service_role";
grant truncate on table "public"."employee_tax_docs" to "service_role";
grant update on table "public"."employee_tax_docs" to "service_role";
grant delete on table "public"."employees" to "anon";
grant insert on table "public"."employees" to "anon";
grant references on table "public"."employees" to "anon";
grant select on table "public"."employees" to "anon";
grant trigger on table "public"."employees" to "anon";
grant truncate on table "public"."employees" to "anon";
grant update on table "public"."employees" to "anon";
grant delete on table "public"."employees" to "authenticated";
grant insert on table "public"."employees" to "authenticated";
grant references on table "public"."employees" to "authenticated";
grant select on table "public"."employees" to "authenticated";
grant trigger on table "public"."employees" to "authenticated";
grant truncate on table "public"."employees" to "authenticated";
grant update on table "public"."employees" to "authenticated";
grant delete on table "public"."employees" to "service_role";
grant insert on table "public"."employees" to "service_role";
grant references on table "public"."employees" to "service_role";
grant select on table "public"."employees" to "service_role";
grant trigger on table "public"."employees" to "service_role";
grant truncate on table "public"."employees" to "service_role";
grant update on table "public"."employees" to "service_role";
grant delete on table "public"."favorites" to "anon";
grant insert on table "public"."favorites" to "anon";
grant references on table "public"."favorites" to "anon";
grant select on table "public"."favorites" to "anon";
grant trigger on table "public"."favorites" to "anon";
grant truncate on table "public"."favorites" to "anon";
grant update on table "public"."favorites" to "anon";
grant delete on table "public"."favorites" to "authenticated";
grant insert on table "public"."favorites" to "authenticated";
grant references on table "public"."favorites" to "authenticated";
grant select on table "public"."favorites" to "authenticated";
grant trigger on table "public"."favorites" to "authenticated";
grant truncate on table "public"."favorites" to "authenticated";
grant update on table "public"."favorites" to "authenticated";
grant delete on table "public"."favorites" to "service_role";
grant insert on table "public"."favorites" to "service_role";
grant references on table "public"."favorites" to "service_role";
grant select on table "public"."favorites" to "service_role";
grant trigger on table "public"."favorites" to "service_role";
grant truncate on table "public"."favorites" to "service_role";
grant update on table "public"."favorites" to "service_role";
grant delete on table "public"."item_stock_locations" to "anon";
grant insert on table "public"."item_stock_locations" to "anon";
grant references on table "public"."item_stock_locations" to "anon";
grant select on table "public"."item_stock_locations" to "anon";
grant trigger on table "public"."item_stock_locations" to "anon";
grant truncate on table "public"."item_stock_locations" to "anon";
grant update on table "public"."item_stock_locations" to "anon";
grant delete on table "public"."item_stock_locations" to "authenticated";
grant insert on table "public"."item_stock_locations" to "authenticated";
grant references on table "public"."item_stock_locations" to "authenticated";
grant select on table "public"."item_stock_locations" to "authenticated";
grant trigger on table "public"."item_stock_locations" to "authenticated";
grant truncate on table "public"."item_stock_locations" to "authenticated";
grant update on table "public"."item_stock_locations" to "authenticated";
grant delete on table "public"."item_stock_locations" to "service_role";
grant insert on table "public"."item_stock_locations" to "service_role";
grant references on table "public"."item_stock_locations" to "service_role";
grant select on table "public"."item_stock_locations" to "service_role";
grant trigger on table "public"."item_stock_locations" to "service_role";
grant truncate on table "public"."item_stock_locations" to "service_role";
grant update on table "public"."item_stock_locations" to "service_role";
grant delete on table "public"."item_types" to "anon";
grant insert on table "public"."item_types" to "anon";
grant references on table "public"."item_types" to "anon";
grant select on table "public"."item_types" to "anon";
grant trigger on table "public"."item_types" to "anon";
grant truncate on table "public"."item_types" to "anon";
grant update on table "public"."item_types" to "anon";
grant delete on table "public"."item_types" to "authenticated";
grant insert on table "public"."item_types" to "authenticated";
grant references on table "public"."item_types" to "authenticated";
grant select on table "public"."item_types" to "authenticated";
grant trigger on table "public"."item_types" to "authenticated";
grant truncate on table "public"."item_types" to "authenticated";
grant update on table "public"."item_types" to "authenticated";
grant delete on table "public"."item_types" to "service_role";
grant insert on table "public"."item_types" to "service_role";
grant references on table "public"."item_types" to "service_role";
grant select on table "public"."item_types" to "service_role";
grant trigger on table "public"."item_types" to "service_role";
grant truncate on table "public"."item_types" to "service_role";
grant update on table "public"."item_types" to "service_role";
grant delete on table "public"."locations" to "anon";
grant insert on table "public"."locations" to "anon";
grant references on table "public"."locations" to "anon";
grant select on table "public"."locations" to "anon";
grant trigger on table "public"."locations" to "anon";
grant truncate on table "public"."locations" to "anon";
grant update on table "public"."locations" to "anon";
grant delete on table "public"."locations" to "authenticated";
grant insert on table "public"."locations" to "authenticated";
grant references on table "public"."locations" to "authenticated";
grant select on table "public"."locations" to "authenticated";
grant trigger on table "public"."locations" to "authenticated";
grant truncate on table "public"."locations" to "authenticated";
grant update on table "public"."locations" to "authenticated";
grant delete on table "public"."locations" to "service_role";
grant insert on table "public"."locations" to "service_role";
grant references on table "public"."locations" to "service_role";
grant select on table "public"."locations" to "service_role";
grant trigger on table "public"."locations" to "service_role";
grant truncate on table "public"."locations" to "service_role";
grant update on table "public"."locations" to "service_role";
grant delete on table "public"."metadata" to "anon";
grant insert on table "public"."metadata" to "anon";
grant references on table "public"."metadata" to "anon";
grant select on table "public"."metadata" to "anon";
grant trigger on table "public"."metadata" to "anon";
grant truncate on table "public"."metadata" to "anon";
grant update on table "public"."metadata" to "anon";
grant delete on table "public"."metadata" to "authenticated";
grant insert on table "public"."metadata" to "authenticated";
grant references on table "public"."metadata" to "authenticated";
grant select on table "public"."metadata" to "authenticated";
grant trigger on table "public"."metadata" to "authenticated";
grant truncate on table "public"."metadata" to "authenticated";
grant update on table "public"."metadata" to "authenticated";
grant delete on table "public"."metadata" to "service_role";
grant insert on table "public"."metadata" to "service_role";
grant references on table "public"."metadata" to "service_role";
grant select on table "public"."metadata" to "service_role";
grant trigger on table "public"."metadata" to "service_role";
grant truncate on table "public"."metadata" to "service_role";
grant update on table "public"."metadata" to "service_role";
grant delete on table "public"."metal_spot_prices" to "anon";
grant insert on table "public"."metal_spot_prices" to "anon";
grant references on table "public"."metal_spot_prices" to "anon";
grant select on table "public"."metal_spot_prices" to "anon";
grant trigger on table "public"."metal_spot_prices" to "anon";
grant truncate on table "public"."metal_spot_prices" to "anon";
grant update on table "public"."metal_spot_prices" to "anon";
grant delete on table "public"."metal_spot_prices" to "authenticated";
grant insert on table "public"."metal_spot_prices" to "authenticated";
grant references on table "public"."metal_spot_prices" to "authenticated";
grant select on table "public"."metal_spot_prices" to "authenticated";
grant trigger on table "public"."metal_spot_prices" to "authenticated";
grant truncate on table "public"."metal_spot_prices" to "authenticated";
grant update on table "public"."metal_spot_prices" to "authenticated";
grant delete on table "public"."metal_spot_prices" to "service_role";
grant insert on table "public"."metal_spot_prices" to "service_role";
grant references on table "public"."metal_spot_prices" to "service_role";
grant select on table "public"."metal_spot_prices" to "service_role";
grant trigger on table "public"."metal_spot_prices" to "service_role";
grant truncate on table "public"."metal_spot_prices" to "service_role";
grant update on table "public"."metal_spot_prices" to "service_role";
grant references on table "public"."pay_periods" to "anon";
grant select on table "public"."pay_periods" to "anon";
grant trigger on table "public"."pay_periods" to "anon";
grant truncate on table "public"."pay_periods" to "anon";
grant references on table "public"."pay_periods" to "authenticated";
grant select on table "public"."pay_periods" to "authenticated";
grant trigger on table "public"."pay_periods" to "authenticated";
grant truncate on table "public"."pay_periods" to "authenticated";
grant delete on table "public"."pay_periods" to "service_role";
grant insert on table "public"."pay_periods" to "service_role";
grant references on table "public"."pay_periods" to "service_role";
grant select on table "public"."pay_periods" to "service_role";
grant trigger on table "public"."pay_periods" to "service_role";
grant truncate on table "public"."pay_periods" to "service_role";
grant update on table "public"."pay_periods" to "service_role";
grant delete on table "public"."payroll_run_lines" to "anon";
grant insert on table "public"."payroll_run_lines" to "anon";
grant references on table "public"."payroll_run_lines" to "anon";
grant select on table "public"."payroll_run_lines" to "anon";
grant trigger on table "public"."payroll_run_lines" to "anon";
grant truncate on table "public"."payroll_run_lines" to "anon";
grant update on table "public"."payroll_run_lines" to "anon";
grant delete on table "public"."payroll_run_lines" to "authenticated";
grant insert on table "public"."payroll_run_lines" to "authenticated";
grant references on table "public"."payroll_run_lines" to "authenticated";
grant select on table "public"."payroll_run_lines" to "authenticated";
grant trigger on table "public"."payroll_run_lines" to "authenticated";
grant truncate on table "public"."payroll_run_lines" to "authenticated";
grant update on table "public"."payroll_run_lines" to "authenticated";
grant delete on table "public"."payroll_run_lines" to "service_role";
grant insert on table "public"."payroll_run_lines" to "service_role";
grant references on table "public"."payroll_run_lines" to "service_role";
grant select on table "public"."payroll_run_lines" to "service_role";
grant trigger on table "public"."payroll_run_lines" to "service_role";
grant truncate on table "public"."payroll_run_lines" to "service_role";
grant update on table "public"."payroll_run_lines" to "service_role";
grant delete on table "public"."payroll_runs" to "anon";
grant insert on table "public"."payroll_runs" to "anon";
grant references on table "public"."payroll_runs" to "anon";
grant select on table "public"."payroll_runs" to "anon";
grant trigger on table "public"."payroll_runs" to "anon";
grant truncate on table "public"."payroll_runs" to "anon";
grant update on table "public"."payroll_runs" to "anon";
grant delete on table "public"."payroll_runs" to "authenticated";
grant insert on table "public"."payroll_runs" to "authenticated";
grant references on table "public"."payroll_runs" to "authenticated";
grant select on table "public"."payroll_runs" to "authenticated";
grant trigger on table "public"."payroll_runs" to "authenticated";
grant truncate on table "public"."payroll_runs" to "authenticated";
grant update on table "public"."payroll_runs" to "authenticated";
grant delete on table "public"."payroll_runs" to "service_role";
grant insert on table "public"."payroll_runs" to "service_role";
grant references on table "public"."payroll_runs" to "service_role";
grant select on table "public"."payroll_runs" to "service_role";
grant trigger on table "public"."payroll_runs" to "service_role";
grant truncate on table "public"."payroll_runs" to "service_role";
grant update on table "public"."payroll_runs" to "service_role";
grant delete on table "public"."payroll_statements" to "anon";
grant insert on table "public"."payroll_statements" to "anon";
grant references on table "public"."payroll_statements" to "anon";
grant select on table "public"."payroll_statements" to "anon";
grant trigger on table "public"."payroll_statements" to "anon";
grant truncate on table "public"."payroll_statements" to "anon";
grant update on table "public"."payroll_statements" to "anon";
grant delete on table "public"."payroll_statements" to "authenticated";
grant insert on table "public"."payroll_statements" to "authenticated";
grant references on table "public"."payroll_statements" to "authenticated";
grant select on table "public"."payroll_statements" to "authenticated";
grant trigger on table "public"."payroll_statements" to "authenticated";
grant truncate on table "public"."payroll_statements" to "authenticated";
grant update on table "public"."payroll_statements" to "authenticated";
grant delete on table "public"."payroll_statements" to "service_role";
grant insert on table "public"."payroll_statements" to "service_role";
grant references on table "public"."payroll_statements" to "service_role";
grant select on table "public"."payroll_statements" to "service_role";
grant trigger on table "public"."payroll_statements" to "service_role";
grant truncate on table "public"."payroll_statements" to "service_role";
grant update on table "public"."payroll_statements" to "service_role";
grant delete on table "public"."payroll_tax_constants" to "anon";
grant insert on table "public"."payroll_tax_constants" to "anon";
grant references on table "public"."payroll_tax_constants" to "anon";
grant select on table "public"."payroll_tax_constants" to "anon";
grant trigger on table "public"."payroll_tax_constants" to "anon";
grant truncate on table "public"."payroll_tax_constants" to "anon";
grant update on table "public"."payroll_tax_constants" to "anon";
grant delete on table "public"."payroll_tax_constants" to "authenticated";
grant insert on table "public"."payroll_tax_constants" to "authenticated";
grant references on table "public"."payroll_tax_constants" to "authenticated";
grant select on table "public"."payroll_tax_constants" to "authenticated";
grant trigger on table "public"."payroll_tax_constants" to "authenticated";
grant truncate on table "public"."payroll_tax_constants" to "authenticated";
grant update on table "public"."payroll_tax_constants" to "authenticated";
grant delete on table "public"."payroll_tax_constants" to "service_role";
grant insert on table "public"."payroll_tax_constants" to "service_role";
grant references on table "public"."payroll_tax_constants" to "service_role";
grant select on table "public"."payroll_tax_constants" to "service_role";
grant trigger on table "public"."payroll_tax_constants" to "service_role";
grant truncate on table "public"."payroll_tax_constants" to "service_role";
grant update on table "public"."payroll_tax_constants" to "service_role";
grant delete on table "public"."sale_item_categories" to "anon";
grant insert on table "public"."sale_item_categories" to "anon";
grant references on table "public"."sale_item_categories" to "anon";
grant select on table "public"."sale_item_categories" to "anon";
grant trigger on table "public"."sale_item_categories" to "anon";
grant truncate on table "public"."sale_item_categories" to "anon";
grant update on table "public"."sale_item_categories" to "anon";
grant delete on table "public"."sale_item_categories" to "authenticated";
grant insert on table "public"."sale_item_categories" to "authenticated";
grant references on table "public"."sale_item_categories" to "authenticated";
grant select on table "public"."sale_item_categories" to "authenticated";
grant trigger on table "public"."sale_item_categories" to "authenticated";
grant truncate on table "public"."sale_item_categories" to "authenticated";
grant update on table "public"."sale_item_categories" to "authenticated";
grant delete on table "public"."sale_item_categories" to "service_role";
grant insert on table "public"."sale_item_categories" to "service_role";
grant references on table "public"."sale_item_categories" to "service_role";
grant select on table "public"."sale_item_categories" to "service_role";
grant trigger on table "public"."sale_item_categories" to "service_role";
grant truncate on table "public"."sale_item_categories" to "service_role";
grant update on table "public"."sale_item_categories" to "service_role";
grant delete on table "public"."sale_items" to "anon";
grant insert on table "public"."sale_items" to "anon";
grant references on table "public"."sale_items" to "anon";
grant select on table "public"."sale_items" to "anon";
grant trigger on table "public"."sale_items" to "anon";
grant truncate on table "public"."sale_items" to "anon";
grant update on table "public"."sale_items" to "anon";
grant delete on table "public"."sale_items" to "authenticated";
grant insert on table "public"."sale_items" to "authenticated";
grant references on table "public"."sale_items" to "authenticated";
grant select on table "public"."sale_items" to "authenticated";
grant trigger on table "public"."sale_items" to "authenticated";
grant truncate on table "public"."sale_items" to "authenticated";
grant update on table "public"."sale_items" to "authenticated";
grant delete on table "public"."sale_items" to "service_role";
grant insert on table "public"."sale_items" to "service_role";
grant references on table "public"."sale_items" to "service_role";
grant select on table "public"."sale_items" to "service_role";
grant trigger on table "public"."sale_items" to "service_role";
grant truncate on table "public"."sale_items" to "service_role";
grant update on table "public"."sale_items" to "service_role";
grant delete on table "public"."sales" to "anon";
grant insert on table "public"."sales" to "anon";
grant references on table "public"."sales" to "anon";
grant select on table "public"."sales" to "anon";
grant trigger on table "public"."sales" to "anon";
grant truncate on table "public"."sales" to "anon";
grant update on table "public"."sales" to "anon";
grant delete on table "public"."sales" to "authenticated";
grant insert on table "public"."sales" to "authenticated";
grant references on table "public"."sales" to "authenticated";
grant select on table "public"."sales" to "authenticated";
grant trigger on table "public"."sales" to "authenticated";
grant truncate on table "public"."sales" to "authenticated";
grant update on table "public"."sales" to "authenticated";
grant delete on table "public"."sales" to "service_role";
grant insert on table "public"."sales" to "service_role";
grant references on table "public"."sales" to "service_role";
grant select on table "public"."sales" to "service_role";
grant trigger on table "public"."sales" to "service_role";
grant truncate on table "public"."sales" to "service_role";
grant update on table "public"."sales" to "service_role";
grant delete on table "public"."sales_audit" to "anon";
grant insert on table "public"."sales_audit" to "anon";
grant references on table "public"."sales_audit" to "anon";
grant select on table "public"."sales_audit" to "anon";
grant trigger on table "public"."sales_audit" to "anon";
grant truncate on table "public"."sales_audit" to "anon";
grant update on table "public"."sales_audit" to "anon";
grant delete on table "public"."sales_audit" to "authenticated";
grant insert on table "public"."sales_audit" to "authenticated";
grant references on table "public"."sales_audit" to "authenticated";
grant select on table "public"."sales_audit" to "authenticated";
grant trigger on table "public"."sales_audit" to "authenticated";
grant truncate on table "public"."sales_audit" to "authenticated";
grant update on table "public"."sales_audit" to "authenticated";
grant delete on table "public"."sales_audit" to "service_role";
grant insert on table "public"."sales_audit" to "service_role";
grant references on table "public"."sales_audit" to "service_role";
grant select on table "public"."sales_audit" to "service_role";
grant trigger on table "public"."sales_audit" to "service_role";
grant truncate on table "public"."sales_audit" to "service_role";
grant update on table "public"."sales_audit" to "service_role";
grant delete on table "public"."sales_channels" to "anon";
grant insert on table "public"."sales_channels" to "anon";
grant references on table "public"."sales_channels" to "anon";
grant select on table "public"."sales_channels" to "anon";
grant trigger on table "public"."sales_channels" to "anon";
grant truncate on table "public"."sales_channels" to "anon";
grant update on table "public"."sales_channels" to "anon";
grant delete on table "public"."sales_channels" to "authenticated";
grant insert on table "public"."sales_channels" to "authenticated";
grant references on table "public"."sales_channels" to "authenticated";
grant select on table "public"."sales_channels" to "authenticated";
grant trigger on table "public"."sales_channels" to "authenticated";
grant truncate on table "public"."sales_channels" to "authenticated";
grant update on table "public"."sales_channels" to "authenticated";
grant delete on table "public"."sales_channels" to "service_role";
grant insert on table "public"."sales_channels" to "service_role";
grant references on table "public"."sales_channels" to "service_role";
grant select on table "public"."sales_channels" to "service_role";
grant trigger on table "public"."sales_channels" to "service_role";
grant truncate on table "public"."sales_channels" to "service_role";
grant update on table "public"."sales_channels" to "service_role";
grant references on table "public"."shift_adjustments" to "anon";
grant select on table "public"."shift_adjustments" to "anon";
grant trigger on table "public"."shift_adjustments" to "anon";
grant truncate on table "public"."shift_adjustments" to "anon";
grant references on table "public"."shift_adjustments" to "authenticated";
grant select on table "public"."shift_adjustments" to "authenticated";
grant trigger on table "public"."shift_adjustments" to "authenticated";
grant truncate on table "public"."shift_adjustments" to "authenticated";
grant delete on table "public"."shift_adjustments" to "service_role";
grant insert on table "public"."shift_adjustments" to "service_role";
grant references on table "public"."shift_adjustments" to "service_role";
grant select on table "public"."shift_adjustments" to "service_role";
grant trigger on table "public"."shift_adjustments" to "service_role";
grant truncate on table "public"."shift_adjustments" to "service_role";
grant update on table "public"."shift_adjustments" to "service_role";
grant references on table "public"."shift_approvals" to "anon";
grant select on table "public"."shift_approvals" to "anon";
grant trigger on table "public"."shift_approvals" to "anon";
grant truncate on table "public"."shift_approvals" to "anon";
grant references on table "public"."shift_approvals" to "authenticated";
grant select on table "public"."shift_approvals" to "authenticated";
grant trigger on table "public"."shift_approvals" to "authenticated";
grant truncate on table "public"."shift_approvals" to "authenticated";
grant delete on table "public"."shift_approvals" to "service_role";
grant insert on table "public"."shift_approvals" to "service_role";
grant references on table "public"."shift_approvals" to "service_role";
grant select on table "public"."shift_approvals" to "service_role";
grant trigger on table "public"."shift_approvals" to "service_role";
grant truncate on table "public"."shift_approvals" to "service_role";
grant update on table "public"."shift_approvals" to "service_role";
grant delete on table "public"."sms_outbox" to "anon";
grant insert on table "public"."sms_outbox" to "anon";
grant references on table "public"."sms_outbox" to "anon";
grant select on table "public"."sms_outbox" to "anon";
grant trigger on table "public"."sms_outbox" to "anon";
grant truncate on table "public"."sms_outbox" to "anon";
grant update on table "public"."sms_outbox" to "anon";
grant delete on table "public"."sms_outbox" to "authenticated";
grant insert on table "public"."sms_outbox" to "authenticated";
grant references on table "public"."sms_outbox" to "authenticated";
grant select on table "public"."sms_outbox" to "authenticated";
grant trigger on table "public"."sms_outbox" to "authenticated";
grant truncate on table "public"."sms_outbox" to "authenticated";
grant update on table "public"."sms_outbox" to "authenticated";
grant delete on table "public"."sms_outbox" to "service_role";
grant insert on table "public"."sms_outbox" to "service_role";
grant references on table "public"."sms_outbox" to "service_role";
grant select on table "public"."sms_outbox" to "service_role";
grant trigger on table "public"."sms_outbox" to "service_role";
grant truncate on table "public"."sms_outbox" to "service_role";
grant update on table "public"."sms_outbox" to "service_role";
grant delete on table "public"."stock_transactions" to "anon";
grant insert on table "public"."stock_transactions" to "anon";
grant references on table "public"."stock_transactions" to "anon";
grant select on table "public"."stock_transactions" to "anon";
grant trigger on table "public"."stock_transactions" to "anon";
grant truncate on table "public"."stock_transactions" to "anon";
grant update on table "public"."stock_transactions" to "anon";
grant delete on table "public"."stock_transactions" to "authenticated";
grant insert on table "public"."stock_transactions" to "authenticated";
grant references on table "public"."stock_transactions" to "authenticated";
grant select on table "public"."stock_transactions" to "authenticated";
grant trigger on table "public"."stock_transactions" to "authenticated";
grant truncate on table "public"."stock_transactions" to "authenticated";
grant update on table "public"."stock_transactions" to "authenticated";
grant delete on table "public"."stock_transactions" to "service_role";
grant insert on table "public"."stock_transactions" to "service_role";
grant references on table "public"."stock_transactions" to "service_role";
grant select on table "public"."stock_transactions" to "service_role";
grant trigger on table "public"."stock_transactions" to "service_role";
grant truncate on table "public"."stock_transactions" to "service_role";
grant update on table "public"."stock_transactions" to "service_role";
grant delete on table "public"."store_locations" to "anon";
grant insert on table "public"."store_locations" to "anon";
grant references on table "public"."store_locations" to "anon";
grant select on table "public"."store_locations" to "anon";
grant trigger on table "public"."store_locations" to "anon";
grant truncate on table "public"."store_locations" to "anon";
grant update on table "public"."store_locations" to "anon";
grant delete on table "public"."store_locations" to "authenticated";
grant insert on table "public"."store_locations" to "authenticated";
grant references on table "public"."store_locations" to "authenticated";
grant select on table "public"."store_locations" to "authenticated";
grant trigger on table "public"."store_locations" to "authenticated";
grant truncate on table "public"."store_locations" to "authenticated";
grant update on table "public"."store_locations" to "authenticated";
grant delete on table "public"."store_locations" to "service_role";
grant insert on table "public"."store_locations" to "service_role";
grant references on table "public"."store_locations" to "service_role";
grant select on table "public"."store_locations" to "service_role";
grant trigger on table "public"."store_locations" to "service_role";
grant truncate on table "public"."store_locations" to "service_role";
grant update on table "public"."store_locations" to "service_role";
grant delete on table "public"."storefront_listings" to "anon";
grant insert on table "public"."storefront_listings" to "anon";
grant references on table "public"."storefront_listings" to "anon";
grant select on table "public"."storefront_listings" to "anon";
grant trigger on table "public"."storefront_listings" to "anon";
grant truncate on table "public"."storefront_listings" to "anon";
grant update on table "public"."storefront_listings" to "anon";
grant delete on table "public"."storefront_listings" to "authenticated";
grant insert on table "public"."storefront_listings" to "authenticated";
grant references on table "public"."storefront_listings" to "authenticated";
grant select on table "public"."storefront_listings" to "authenticated";
grant trigger on table "public"."storefront_listings" to "authenticated";
grant truncate on table "public"."storefront_listings" to "authenticated";
grant update on table "public"."storefront_listings" to "authenticated";
grant delete on table "public"."storefront_listings" to "service_role";
grant insert on table "public"."storefront_listings" to "service_role";
grant references on table "public"."storefront_listings" to "service_role";
grant select on table "public"."storefront_listings" to "service_role";
grant trigger on table "public"."storefront_listings" to "service_role";
grant truncate on table "public"."storefront_listings" to "service_role";
grant update on table "public"."storefront_listings" to "service_role";
grant delete on table "public"."tax_doc_access_logs" to "anon";
grant insert on table "public"."tax_doc_access_logs" to "anon";
grant references on table "public"."tax_doc_access_logs" to "anon";
grant select on table "public"."tax_doc_access_logs" to "anon";
grant trigger on table "public"."tax_doc_access_logs" to "anon";
grant truncate on table "public"."tax_doc_access_logs" to "anon";
grant update on table "public"."tax_doc_access_logs" to "anon";
grant delete on table "public"."tax_doc_access_logs" to "authenticated";
grant insert on table "public"."tax_doc_access_logs" to "authenticated";
grant references on table "public"."tax_doc_access_logs" to "authenticated";
grant select on table "public"."tax_doc_access_logs" to "authenticated";
grant trigger on table "public"."tax_doc_access_logs" to "authenticated";
grant truncate on table "public"."tax_doc_access_logs" to "authenticated";
grant update on table "public"."tax_doc_access_logs" to "authenticated";
grant delete on table "public"."tax_doc_access_logs" to "service_role";
grant insert on table "public"."tax_doc_access_logs" to "service_role";
grant references on table "public"."tax_doc_access_logs" to "service_role";
grant select on table "public"."tax_doc_access_logs" to "service_role";
grant trigger on table "public"."tax_doc_access_logs" to "service_role";
grant truncate on table "public"."tax_doc_access_logs" to "service_role";
grant update on table "public"."tax_doc_access_logs" to "service_role";
grant delete on table "public"."time_breaks" to "anon";
grant insert on table "public"."time_breaks" to "anon";
grant references on table "public"."time_breaks" to "anon";
grant select on table "public"."time_breaks" to "anon";
grant trigger on table "public"."time_breaks" to "anon";
grant truncate on table "public"."time_breaks" to "anon";
grant update on table "public"."time_breaks" to "anon";
grant delete on table "public"."time_breaks" to "authenticated";
grant insert on table "public"."time_breaks" to "authenticated";
grant references on table "public"."time_breaks" to "authenticated";
grant select on table "public"."time_breaks" to "authenticated";
grant trigger on table "public"."time_breaks" to "authenticated";
grant truncate on table "public"."time_breaks" to "authenticated";
grant update on table "public"."time_breaks" to "authenticated";
grant delete on table "public"."time_breaks" to "service_role";
grant insert on table "public"."time_breaks" to "service_role";
grant references on table "public"."time_breaks" to "service_role";
grant select on table "public"."time_breaks" to "service_role";
grant trigger on table "public"."time_breaks" to "service_role";
grant truncate on table "public"."time_breaks" to "service_role";
grant update on table "public"."time_breaks" to "service_role";
grant references on table "public"."time_entries" to "anon";
grant select on table "public"."time_entries" to "anon";
grant trigger on table "public"."time_entries" to "anon";
grant truncate on table "public"."time_entries" to "anon";
grant references on table "public"."time_entries" to "authenticated";
grant select on table "public"."time_entries" to "authenticated";
grant trigger on table "public"."time_entries" to "authenticated";
grant truncate on table "public"."time_entries" to "authenticated";
grant delete on table "public"."time_entries" to "service_role";
grant insert on table "public"."time_entries" to "service_role";
grant references on table "public"."time_entries" to "service_role";
grant select on table "public"."time_entries" to "service_role";
grant trigger on table "public"."time_entries" to "service_role";
grant truncate on table "public"."time_entries" to "service_role";
grant update on table "public"."time_entries" to "service_role";
grant delete on table "public"."timeclock_day_exceptions" to "anon";
grant insert on table "public"."timeclock_day_exceptions" to "anon";
grant references on table "public"."timeclock_day_exceptions" to "anon";
grant select on table "public"."timeclock_day_exceptions" to "anon";
grant trigger on table "public"."timeclock_day_exceptions" to "anon";
grant truncate on table "public"."timeclock_day_exceptions" to "anon";
grant update on table "public"."timeclock_day_exceptions" to "anon";
grant delete on table "public"."timeclock_day_exceptions" to "authenticated";
grant insert on table "public"."timeclock_day_exceptions" to "authenticated";
grant references on table "public"."timeclock_day_exceptions" to "authenticated";
grant select on table "public"."timeclock_day_exceptions" to "authenticated";
grant trigger on table "public"."timeclock_day_exceptions" to "authenticated";
grant truncate on table "public"."timeclock_day_exceptions" to "authenticated";
grant update on table "public"."timeclock_day_exceptions" to "authenticated";
grant delete on table "public"."timeclock_day_exceptions" to "service_role";
grant insert on table "public"."timeclock_day_exceptions" to "service_role";
grant references on table "public"."timeclock_day_exceptions" to "service_role";
grant select on table "public"."timeclock_day_exceptions" to "service_role";
grant trigger on table "public"."timeclock_day_exceptions" to "service_role";
grant truncate on table "public"."timeclock_day_exceptions" to "service_role";
grant update on table "public"."timeclock_day_exceptions" to "service_role";
grant delete on table "public"."timeclock_store_exceptions" to "anon";
grant insert on table "public"."timeclock_store_exceptions" to "anon";
grant references on table "public"."timeclock_store_exceptions" to "anon";
grant select on table "public"."timeclock_store_exceptions" to "anon";
grant trigger on table "public"."timeclock_store_exceptions" to "anon";
grant truncate on table "public"."timeclock_store_exceptions" to "anon";
grant update on table "public"."timeclock_store_exceptions" to "anon";
grant delete on table "public"."timeclock_store_exceptions" to "authenticated";
grant insert on table "public"."timeclock_store_exceptions" to "authenticated";
grant references on table "public"."timeclock_store_exceptions" to "authenticated";
grant select on table "public"."timeclock_store_exceptions" to "authenticated";
grant trigger on table "public"."timeclock_store_exceptions" to "authenticated";
grant truncate on table "public"."timeclock_store_exceptions" to "authenticated";
grant update on table "public"."timeclock_store_exceptions" to "authenticated";
grant delete on table "public"."timeclock_store_exceptions" to "service_role";
grant insert on table "public"."timeclock_store_exceptions" to "service_role";
grant references on table "public"."timeclock_store_exceptions" to "service_role";
grant select on table "public"."timeclock_store_exceptions" to "service_role";
grant trigger on table "public"."timeclock_store_exceptions" to "service_role";
grant truncate on table "public"."timeclock_store_exceptions" to "service_role";
grant update on table "public"."timeclock_store_exceptions" to "service_role";
grant delete on table "public"."user_phones" to "anon";
grant insert on table "public"."user_phones" to "anon";
grant references on table "public"."user_phones" to "anon";
grant select on table "public"."user_phones" to "anon";
grant trigger on table "public"."user_phones" to "anon";
grant truncate on table "public"."user_phones" to "anon";
grant update on table "public"."user_phones" to "anon";
grant delete on table "public"."user_phones" to "authenticated";
grant insert on table "public"."user_phones" to "authenticated";
grant references on table "public"."user_phones" to "authenticated";
grant select on table "public"."user_phones" to "authenticated";
grant trigger on table "public"."user_phones" to "authenticated";
grant truncate on table "public"."user_phones" to "authenticated";
grant update on table "public"."user_phones" to "authenticated";
grant delete on table "public"."user_phones" to "service_role";
grant insert on table "public"."user_phones" to "service_role";
grant references on table "public"."user_phones" to "service_role";
grant select on table "public"."user_phones" to "service_role";
grant trigger on table "public"."user_phones" to "service_role";
grant truncate on table "public"."user_phones" to "service_role";
grant update on table "public"."user_phones" to "service_role";
grant delete on table "public"."work_schedule_overrides" to "anon";
grant insert on table "public"."work_schedule_overrides" to "anon";
grant references on table "public"."work_schedule_overrides" to "anon";
grant select on table "public"."work_schedule_overrides" to "anon";
grant trigger on table "public"."work_schedule_overrides" to "anon";
grant truncate on table "public"."work_schedule_overrides" to "anon";
grant update on table "public"."work_schedule_overrides" to "anon";
grant delete on table "public"."work_schedule_overrides" to "authenticated";
grant insert on table "public"."work_schedule_overrides" to "authenticated";
grant references on table "public"."work_schedule_overrides" to "authenticated";
grant select on table "public"."work_schedule_overrides" to "authenticated";
grant trigger on table "public"."work_schedule_overrides" to "authenticated";
grant truncate on table "public"."work_schedule_overrides" to "authenticated";
grant update on table "public"."work_schedule_overrides" to "authenticated";
grant delete on table "public"."work_schedule_overrides" to "service_role";
grant insert on table "public"."work_schedule_overrides" to "service_role";
grant references on table "public"."work_schedule_overrides" to "service_role";
grant select on table "public"."work_schedule_overrides" to "service_role";
grant trigger on table "public"."work_schedule_overrides" to "service_role";
grant truncate on table "public"."work_schedule_overrides" to "service_role";
grant update on table "public"."work_schedule_overrides" to "service_role";
grant delete on table "public"."work_schedules" to "anon";
grant insert on table "public"."work_schedules" to "anon";
grant references on table "public"."work_schedules" to "anon";
grant select on table "public"."work_schedules" to "anon";
grant trigger on table "public"."work_schedules" to "anon";
grant truncate on table "public"."work_schedules" to "anon";
grant update on table "public"."work_schedules" to "anon";
grant delete on table "public"."work_schedules" to "authenticated";
grant insert on table "public"."work_schedules" to "authenticated";
grant references on table "public"."work_schedules" to "authenticated";
grant select on table "public"."work_schedules" to "authenticated";
grant trigger on table "public"."work_schedules" to "authenticated";
grant truncate on table "public"."work_schedules" to "authenticated";
grant update on table "public"."work_schedules" to "authenticated";
grant delete on table "public"."work_schedules" to "service_role";
grant insert on table "public"."work_schedules" to "service_role";
grant references on table "public"."work_schedules" to "service_role";
grant select on table "public"."work_schedules" to "service_role";
grant trigger on table "public"."work_schedules" to "service_role";
grant truncate on table "public"."work_schedules" to "service_role";
grant update on table "public"."work_schedules" to "service_role";
create policy "bulk_batches_insert_admin_only"
  on "public"."bulk_batches"
  as permissive
  for insert
  to authenticated
with check ((public.is_admin() AND (created_by = auth.uid())));
create policy "bulk_batches_select"
  on "public"."bulk_batches"
  as permissive
  for select
  to authenticated
using (true);
create policy "bulk_batches_update_admin_only"
  on "public"."bulk_batches"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "contractor_payments_admin_all"
  on "public"."contractor_payments"
  as permissive
  for all
  to public
using (public.is_admin())
with check (public.is_admin());
create policy "contractor_payments_self_read"
  on "public"."contractor_payments"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = contractor_payments.employee_id) AND (e.user_id = auth.uid())))));
create policy "admin_insert_addresses"
  on "public"."employee_legal_addresses"
  as permissive
  for insert
  to public
with check (public.is_admin());
create policy "admin_select_addresses"
  on "public"."employee_legal_addresses"
  as permissive
  for select
  to public
using (public.is_admin());
create policy "admin_update_addresses"
  on "public"."employee_legal_addresses"
  as permissive
  for update
  to public
using (public.is_admin())
with check (public.is_admin());
create policy "em_select_admin"
  on "public"."employee_managers"
  as permissive
  for select
  to authenticated
using (public.is_admin());
create policy "em_write_admin"
  on "public"."employee_managers"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "employee_rates_admin_all"
  on "public"."employee_rates"
  as permissive
  for all
  to public
using (public.is_admin())
with check (public.is_admin());
create policy "employee_rates_self_read"
  on "public"."employee_rates"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = employee_rates.employee_id) AND (e.user_id = auth.uid())))));
create policy "tax_docs_admin_all"
  on "public"."employee_tax_docs"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "employees_select_self_or_admin"
  on "public"."employees"
  as permissive
  for select
  to authenticated
using (((auth.uid() = user_id) OR public.is_admin()));
create policy "Allow delete for admin"
  on "public"."item_types"
  as permissive
  for delete
  to public
using ((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text));
create policy "Allow insert for admins"
  on "public"."item_types"
  as permissive
  for insert
  to public
with check ((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text));
create policy "Allow select for admins only"
  on "public"."item_types"
  as permissive
  for select
  to public
using ((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text));
create policy "Allow update for admin"
  on "public"."item_types"
  as permissive
  for update
  to public
using ((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text));
create policy "pp_admin_write"
  on "public"."pay_periods"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "pp_select_all"
  on "public"."pay_periods"
  as permissive
  for select
  to authenticated
using (true);
create policy "payroll_run_lines_admin_all"
  on "public"."payroll_run_lines"
  as permissive
  for all
  to public
using (public.is_admin())
with check (public.is_admin());
create policy "payroll_run_lines_self_read"
  on "public"."payroll_run_lines"
  as permissive
  for select
  to authenticated
using (((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = payroll_run_lines.employee_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM public.payroll_runs pr
  WHERE ((pr.id = payroll_run_lines.payroll_run_id) AND (pr.status = 'final'::text))))));
create policy "payroll_runs_admin_all"
  on "public"."payroll_runs"
  as permissive
  for all
  to public
using (public.is_admin())
with check (public.is_admin());
create policy "payroll_runs_employee_final_read"
  on "public"."payroll_runs"
  as permissive
  for select
  to authenticated
using ((status = 'final'::text));
create policy "admin read payroll_statements"
  on "public"."payroll_statements"
  as permissive
  for select
  to public
using (public.is_admin());
create policy "worker read own payroll_statements"
  on "public"."payroll_statements"
  as permissive
  for select
  to public
using ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = payroll_statements.employee_id) AND (e.user_id = auth.uid())))));
create policy "sa_insert_admin_only"
  on "public"."shift_adjustments"
  as permissive
  for insert
  to authenticated
with check (public.is_admin());
create policy "sa_select_admin_all"
  on "public"."shift_adjustments"
  as permissive
  for select
  to authenticated
using (public.is_admin());
create policy "sa_select_employee_own"
  on "public"."shift_adjustments"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM (public.time_entries t
     JOIN public.employees e ON ((e.id = t.employee_id)))
  WHERE ((t.id = shift_adjustments.time_entry_id) AND (e.user_id = auth.uid())))));
create policy "sa_admin_write"
  on "public"."shift_approvals"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "sa_select_all"
  on "public"."shift_approvals"
  as permissive
  for select
  to authenticated
using (true);
create policy "sms_select_admin"
  on "public"."sms_outbox"
  as permissive
  for select
  to authenticated
using (public.is_admin());
create policy "sl_admin_write"
  on "public"."store_locations"
  as permissive
  for all
  to authenticated
using ((EXISTS ( SELECT 1
   FROM public.employees me
  WHERE ((me.user_id = auth.uid()) AND (me.role = 'admin'::text)))))
with check ((EXISTS ( SELECT 1
   FROM public.employees me
  WHERE ((me.user_id = auth.uid()) AND (me.role = 'admin'::text)))));
create policy "sl_select_active"
  on "public"."store_locations"
  as permissive
  for select
  to authenticated
using ((active IS TRUE));
create policy "tax_doc_logs_admin_select"
  on "public"."tax_doc_access_logs"
  as permissive
  for select
  to authenticated
using (public.is_admin());
create policy "time_breaks_delete_admin_only"
  on "public"."time_breaks"
  as permissive
  for delete
  to authenticated
using (public.is_admin());
create policy "time_breaks_insert_admin_only"
  on "public"."time_breaks"
  as permissive
  for insert
  to authenticated
with check (public.is_admin());
create policy "time_breaks_select"
  on "public"."time_breaks"
  as permissive
  for select
  to authenticated
using ((EXISTS ( SELECT 1
   FROM (public.time_entries t
     JOIN public.employees e ON ((e.id = t.employee_id)))
  WHERE ((t.id = time_breaks.time_entry_id) AND ((e.user_id = auth.uid()) OR public.is_admin())))));
create policy "time_breaks_update_admin_only"
  on "public"."time_breaks"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "te_admin_update"
  on "public"."time_entries"
  as permissive
  for update
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "te_select_own_or_admin"
  on "public"."time_entries"
  as permissive
  for select
  to authenticated
using (((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = time_entries.employee_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.employees me
  WHERE ((me.user_id = auth.uid()) AND (me.role = 'admin'::text))))));
create policy "exceptions_admin_write"
  on "public"."timeclock_day_exceptions"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "exceptions_select_own_or_admin"
  on "public"."timeclock_day_exceptions"
  as permissive
  for select
  to authenticated
using ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = timeclock_day_exceptions.employee_id) AND (e.user_id = auth.uid()))))));
create policy "store_exceptions_admin_select"
  on "public"."timeclock_store_exceptions"
  as permissive
  for select
  to authenticated
using (public.is_admin());
create policy "store_exceptions_admin_write"
  on "public"."timeclock_store_exceptions"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "up_select_own_or_admin"
  on "public"."user_phones"
  as permissive
  for select
  to authenticated
using (((auth.uid() = user_id) OR public.is_admin()));
create policy "up_write_own"
  on "public"."user_phones"
  as permissive
  for all
  to authenticated
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));
create policy "wso_select"
  on "public"."work_schedule_overrides"
  as permissive
  for select
  to authenticated
using ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = work_schedule_overrides.employee_id) AND (e.user_id = auth.uid()))))));
create policy "wso_write"
  on "public"."work_schedule_overrides"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
create policy "ws_select"
  on "public"."work_schedules"
  as permissive
  for select
  to authenticated
using ((public.is_admin() OR (EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = work_schedules.employee_id) AND (e.user_id = auth.uid()))))));
create policy "ws_write"
  on "public"."work_schedules"
  as permissive
  for all
  to authenticated
using (public.is_admin())
with check (public.is_admin());
CREATE TRIGGER trg_employee_legal_addresses_make_current AFTER INSERT ON public.employee_legal_addresses FOR EACH ROW EXECUTE FUNCTION public.employee_legal_addresses_make_current();
CREATE TRIGGER trg_employee_legal_addresses_updated_at BEFORE UPDATE ON public.employee_legal_addresses FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_employee_tax_docs_updated_at BEFORE UPDATE ON public.employee_tax_docs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_enforce_contractor_agreement_required BEFORE INSERT OR UPDATE OF worker_type, agreement_version_required ON public.employees FOR EACH ROW EXECUTE FUNCTION public.enforce_contractor_agreement_required();
CREATE TRIGGER trg_sync_batch_qty_from_stock AFTER INSERT OR UPDATE OF quantity ON public.item_stock_locations FOR EACH ROW EXECUTE FUNCTION public.sync_batch_qty_from_stock();
CREATE TRIGGER set_timestamp BEFORE UPDATE ON public.metadata FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();
CREATE TRIGGER trg_sales_channels_updated_at BEFORE UPDATE ON public.sales_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_storefront_listings_updated_at BEFORE UPDATE ON public.storefront_listings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_time_breaks_ai AFTER INSERT ON public.time_breaks FOR EACH ROW EXECUTE FUNCTION public.tr_time_breaks_ai();
CREATE TRIGGER trg_time_breaks_au AFTER UPDATE ON public.time_breaks FOR EACH ROW EXECUTE FUNCTION public.tr_time_breaks_au();
CREATE TRIGGER trg_time_entries_alert_ai AFTER INSERT ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.tr_time_entries_alert_ai();
CREATE TRIGGER trg_time_entries_alert_au AFTER UPDATE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.tr_time_entries_alert_au();
create policy "Admin Permission to upload 1w8qixh_0"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'public-ebay-photos'::text)));
create policy "Admin label upload dymo"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'dymo-labels'::text)));
create policy "Admin label upload photos"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'photos'::text)));
create policy "Admin location-assets upload photos"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'location-assets'::text)));
create policy "Deleting Items for Photos 1io9m69_0"
  on "storage"."objects"
  as permissive
  for delete
  to public
using (((((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text) = 'admin'::text) AND (bucket_id = 'photos'::text)));
create policy "Read labels via signed URL dymo"
  on "storage"."objects"
  as permissive
  for select
  to public
using (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'dymo-labels'::text)));
create policy "Read labels via signed URL photos"
  on "storage"."objects"
  as permissive
  for select
  to public
using (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'photos'::text)));
create policy "Read location-assets via signed URL photos"
  on "storage"."objects"
  as permissive
  for select
  to public
using (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'location-assets'::text)));
create policy "photos_admin_delete"
  on "storage"."objects"
  as permissive
  for delete
  to authenticated
using (((bucket_id = 'timeclock-photos'::text) AND (EXISTS ( SELECT 1
   FROM public.employees me
  WHERE ((me.user_id = auth.uid()) AND (me.role = 'admin'::text))))));
create policy "photos_employee_insert"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'timeclock-photos'::text) AND (EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.user_id = auth.uid()) AND (split_part(objects.name, '/'::text, 1) = (e.id)::text))))));
create policy "photos_employee_read"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'timeclock-photos'::text) AND ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.user_id = auth.uid()) AND (split_part(objects.name, '/'::text, 1) = (e.id)::text)))) OR (EXISTS ( SELECT 1
   FROM public.employees me
  WHERE ((me.user_id = auth.uid()) AND (me.role = 'admin'::text)))))));
create policy "select 1w8qixh_0"
  on "storage"."objects"
  as permissive
  for select
  to public
using (((( SELECT ((auth.jwt() -> 'user_metadata'::text) ->> 'role'::text)) = 'admin'::text) AND (bucket_id = 'public-ebay-photos'::text)));
