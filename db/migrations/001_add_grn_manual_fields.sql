-- Adds manual-entry GRN fields requested for web + mobile parity.
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS gate_in_number VARCHAR(100);
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS model_number VARCHAR(255);
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS material_description TEXT;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS receipt_date DATE;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS manufacturing_date DATE;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS basic_price NUMERIC(12,2);
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS invoice_quantity INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS received_quantity INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS quantity_difference INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS damage_quantity INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS case_count INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS pallet_count INTEGER;
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(12,3);
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS handling_type VARCHAR(20);
ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS source_channel VARCHAR(30);
