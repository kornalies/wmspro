-- Add operational bin status to the warehouse zone layout master.
-- Independent of is_active (soft delete): only AVAILABLE bins accept put-away,
-- while BLOCKED / HOLD / DAMAGED / COUNTING take a bin out of the pool without
-- deleting it.
ALTER TABLE warehouse_zone_layouts
  ADD COLUMN IF NOT EXISTS bin_status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'warehouse_zone_layouts'::regclass
      AND conname = 'warehouse_zone_layouts_bin_status_check'
  ) THEN
    ALTER TABLE warehouse_zone_layouts
      ADD CONSTRAINT warehouse_zone_layouts_bin_status_check
      CHECK (bin_status IN ('AVAILABLE','BLOCKED','HOLD','DAMAGED','COUNTING'));
  END IF;
END
$$;
