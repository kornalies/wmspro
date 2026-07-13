-- Reconcile the two zone tables.
--
-- warehouse_zone_layouts is the bin-level master (Warehouse > Zone > Rack > Bin)
-- managed by the admin UI. warehouse_zones is the coarser zone-level table the
-- stock movement ledger FKs to (stock_movements.from_zone_id / to_zone_id).
-- Previously put-away bridged them by matching zone_code strings, so a layout
-- whose zone had no matching warehouse_zones row wrote NULL into the ledger.
--
-- This adds a real FK link and backfills it, guaranteeing every layout zone has
-- a canonical warehouse_zones row and that the movement ledger keeps its
-- location on every put-away.

ALTER TABLE warehouse_zone_layouts
  ADD COLUMN IF NOT EXISTS warehouse_zone_id INTEGER REFERENCES warehouse_zones(id);

-- 1) Provision a warehouse_zones row for every distinct layout zone that lacks one.
INSERT INTO warehouse_zones (company_id, warehouse_id, zone_code, zone_name, zone_type, is_active)
SELECT
  zl.company_id,
  zl.warehouse_id,
  zl.zone_code,
  MIN(zl.zone_name) AS zone_name,
  MIN(zl.zone_type) AS zone_type,
  true
FROM warehouse_zone_layouts zl
GROUP BY zl.company_id, zl.warehouse_id, zl.zone_code
ON CONFLICT (warehouse_id, zone_code) DO NOTHING;

-- 2) Link every layout to its canonical zone by id.
UPDATE warehouse_zone_layouts zl
SET warehouse_zone_id = wz.id
FROM warehouse_zones wz
WHERE wz.warehouse_id = zl.warehouse_id
  AND wz.zone_code = zl.zone_code
  AND zl.warehouse_zone_id IS DISTINCT FROM wz.id;

CREATE INDEX IF NOT EXISTS idx_zone_layout_warehouse_zone
  ON warehouse_zone_layouts (warehouse_zone_id);
