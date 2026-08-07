--
-- PostgreSQL database dump
--

\restrict pngncBbai2dipSvevh5749jq4yrPe3wkxgaKDF6h1cfLBdhVDSf2Va99YyDH1u1

-- Dumped from database version 18.1
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (filename, applied_at) FROM stdin;
001_add_grn_manual_fields.sql	2026-03-04 11:52:59.951479+05:30
002_add_mobile_grn_captures.sql	2026-03-04 11:52:59.956634+05:30
003_add_stock_putaway_columns.sql	2026-03-04 11:52:59.960103+05:30
004_add_stock_putaway_movements.sql	2026-03-04 11:52:59.96277+05:30
005_add_warehouse_zone_layouts.sql	2026-03-04 11:52:59.965071+05:30
006_add_company_info_fields.sql	2026-03-04 11:52:59.967448+05:30
007_add_contract_management.sql	2026-03-04 11:52:59.97338+05:30
008_add_rbac_permissions.sql	2026-03-04 11:52:59.978077+05:30
009_add_saas_multitenancy.sql	2026-03-04 11:52:59.987685+05:30
010_allow_super_admin_role.sql	2026-03-04 11:59:55.935115+05:30
011_add_billing_core.sql	2026-03-04 11:59:55.996606+05:30
012_add_credit_debit_notes.sql	2026-03-04 11:59:56.008063+05:30
013_add_do_mobile_capture_fields.sql	2026-03-04 11:59:56.014245+05:30
014_add_gate_in_mobile_fields.sql	2026-03-04 11:59:56.017469+05:30
015_add_invoice_normalized_tables.sql	2026-03-04 11:59:56.020362+05:30
016_add_gate_in_departure_datetime.sql	2026-03-04 11:59:56.026392+05:30
017_add_portal_and_idempotency_tables.sql	2026-03-04 11:59:56.029146+05:30
018_add_tenant_policy_system.sql	2026-03-05 12:17:30.82736+05:30
019_audit_logs_compatibility.sql	2026-03-05 12:58:50.070817+05:30
020_audit_logs_action_constraint.sql	2026-03-05 12:59:41.092625+05:30
021_fix_audit_log_trigger_function.sql	2026-03-05 13:07:41.2153+05:30
022_enforce_single_user_role.sql	2026-03-05 14:28:29.043636+05:30
020_expand_do_header_status_check.sql	2026-03-06 10:57:52.447627+05:30
023_backfill_do_header_status_mapping.sql	2026-03-06 11:54:45.598991+05:30
024_fix_update_do_totals_status_mapping.sql	2026-03-06 12:24:43.649222+05:30
025_widen_audit_logs_action_column.sql	2026-03-06 12:45:19.765337+05:30
026_fix_invoice_payments_fk_to_invoice_header.sql	2026-03-06 13:24:20.183154+05:30
027_add_do_wave_task_orchestration.sql	2026-03-06 13:34:15.929248+05:30
028_add_labor_management.sql	2026-03-06 14:15:37.79309+05:30
029_add_edi_carrier_erp_integrations.sql	2026-03-06 14:30:36.27307+05:30
030_add_portal_sla_disputes_and_invoice_actions.sql	2026-03-06 14:53:03.52728+05:30
031_add_wes_robot_orchestration_foundation.sql	2026-03-06 15:06:27.874474+05:30
032_add_portal_permissions_and_invites.sql	2026-03-09 13:26:59.684918+05:30
033_fix_attachments_runtime_grants.sql	2026-03-10 14:27:43.146759+05:30
034_add_client_contact_fields.sql	2026-03-17 10:55:00.563166+05:30
035_add_attachment_file_data.sql	2026-03-17 11:12:58.488176+05:30
036_add_warehouse_coordinates.sql	2026-03-17 12:25:35.263919+05:30
031_add_unrated_billing_status.sql	2026-03-18 11:50:48.624963+05:30
037_add_slab_mode_to_rate_details.sql	2026-03-18 12:01:47.050633+05:30
038_add_item_specific_rate_details.sql	2026-03-18 12:51:56.894163+05:30
039_expand_billing_cycles_to_quarterly_yearly.sql	2026-03-18 13:03:37.148697+05:30
040_add_user_sessions.sql	2026-03-20 11:51:04.25522+05:30
041_fix_mobile_lp_runtime_grants.sql	2026-04-01 17:04:24.152111+05:30
042_make_stock_movement_number_generation_collision_safe.sql	2026-04-01 17:21:19.673082+05:30
043_ensure_client_viewer_roles_active.sql	2026-04-21 14:57:07.300418+05:30
044_add_tenant_product_entitlements.sql	2026-04-21 14:57:07.330338+05:30
045_add_freight_forwarding_phase1.sql	2026-04-21 15:05:30.938247+05:30
046_harden_product_and_freight_rls.sql	2026-04-24 13:08:53.46129+05:30
047_allow_cancelled_stock_serial_status.sql	2026-05-25 11:33:30.509421+05:30
048_add_mobile_auth_sessions_and_sync_queue.sql	2026-07-02 12:33:21.660829+05:30
049_add_notifications.sql	2026-07-07 12:27:10.241432+05:30
050_grant_wms_mobile_app_notifications.sql	2026-07-07 12:36:32.743984+05:30
051_add_zone_layout_zone_type.sql	2026-07-14 10:41:08.468088+05:30
052_add_zone_layout_bin_status.sql	2026-07-14 10:41:08.490575+05:30
053_link_zone_layouts_to_warehouse_zones.sql	2026-07-14 10:41:08.494656+05:30
054_add_putaway_supervisor_pin.sql	2026-07-14 11:41:36.573602+05:30
055_add_qc_reason_code.sql	2026-07-15 10:49:12.252316+05:30
056_add_qc_partial_disposition.sql	2026-07-15 11:00:55.836029+05:30
057_add_company_settings.sql	2026-07-15 11:20:22.704004+05:30
058_add_qc_hold_disposition.sql	2026-07-15 11:30:37.007112+05:30
059_add_stock_lp_link.sql	2026-07-17 11:09:55.554178+05:30
060_enforce_invoice_payment_integrity.sql	2026-07-23 12:10:13.863608+05:30
061_add_invoice_payments_rls.sql	2026-07-23 12:10:13.879098+05:30
062_add_outbound_tail_statuses.sql	2026-07-24 11:58:51.126431+05:30
063_add_outbound_pack_units.sql	2026-07-24 12:10:12.37659+05:30
064_add_goods_issue.sql	2026-07-24 12:10:12.448855+05:30
065_add_outbound_loads_and_delivery_notes.sql	2026-07-24 12:10:12.484979+05:30
066_fix_pack_unit_membership_cascade.sql	2026-07-24 12:31:14.020797+05:30
067_adopt_cycle_counting.sql	2026-07-27 12:32:03.900911+05:30
068_make_allocation_rule_real.sql	2026-07-27 13:18:56.181593+05:30
\.


--
-- PostgreSQL database dump complete
--

\unrestrict pngncBbai2dipSvevh5749jq4yrPe3wkxgaKDF6h1cfLBdhVDSf2Va99YyDH1u1

