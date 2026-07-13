-- Add functional zone classification to the warehouse zone layout master.
-- Lets the WMS distinguish receiving / storage / picking / staging / dispatch etc.
-- so put-away and picking can be directed instead of purely manual.
ALTER TABLE warehouse_zone_layouts
  ADD COLUMN IF NOT EXISTS zone_type VARCHAR(30) NOT NULL DEFAULT 'STORAGE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'warehouse_zone_layouts'::regclass
      AND conname = 'warehouse_zone_layouts_zone_type_check'
  ) THEN
    ALTER TABLE warehouse_zone_layouts
      ADD CONSTRAINT warehouse_zone_layouts_zone_type_check
      CHECK (zone_type IN ('RECEIVING','STORAGE','PICKING','PACKING','STAGING','DISPATCH','RETURNS','QC','QUARANTINE','DAMAGE'));
  END IF;
END
$$;
