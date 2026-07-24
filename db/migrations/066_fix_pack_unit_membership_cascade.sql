-- Track A follow-up: make pack-unit membership rows cascade with their pack unit.
--
-- goods_issue_pack_units.pack_unit_id and outbound_load_pack_units.pack_unit_id
-- were created as plain REFERENCES in migrations 064/065. Both parents
-- (do_pack_units and goods_issue_header / outbound_loads) cascade from
-- do_header, so deleting a DO tries to remove a pack unit and its membership
-- rows in the same statement -- and PostgreSQL does not guarantee it reaches the
-- membership row first. The result is an intermittent
--
--   violates foreign key constraint "goods_issue_pack_units_pack_unit_id_fkey"
--
-- on DO deletion, depending on cascade ordering. Caught by tests/outbound-tail.mjs.
--
-- A membership row has no meaning without its pack unit, so CASCADE is the
-- correct semantics as well as the fix. The constraints that actually protect
-- against double-shipping are the UNIQUE ones on (company_id, pack_unit_id),
-- which are untouched here.

BEGIN;

ALTER TABLE goods_issue_pack_units
  DROP CONSTRAINT IF EXISTS goods_issue_pack_units_pack_unit_id_fkey;
ALTER TABLE goods_issue_pack_units
  ADD CONSTRAINT goods_issue_pack_units_pack_unit_id_fkey
  FOREIGN KEY (pack_unit_id) REFERENCES do_pack_units(id) ON DELETE CASCADE;

ALTER TABLE outbound_load_pack_units
  DROP CONSTRAINT IF EXISTS outbound_load_pack_units_pack_unit_id_fkey;
ALTER TABLE outbound_load_pack_units
  ADD CONSTRAINT outbound_load_pack_units_pack_unit_id_fkey
  FOREIGN KEY (pack_unit_id) REFERENCES do_pack_units(id) ON DELETE CASCADE;

-- delivery_note_lines.do_line_item_id has the same shape: do_header cascades to
-- both do_line_items and delivery_note_header.
ALTER TABLE delivery_note_lines
  DROP CONSTRAINT IF EXISTS delivery_note_lines_do_line_item_id_fkey;
ALTER TABLE delivery_note_lines
  ADD CONSTRAINT delivery_note_lines_do_line_item_id_fkey
  FOREIGN KEY (do_line_item_id) REFERENCES do_line_items(id) ON DELETE CASCADE;

COMMIT;