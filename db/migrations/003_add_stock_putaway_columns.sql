-- Put-away binding to Zone > Rack > Bin layout
ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id);

ALTER TABLE stock_serial_numbers
  ADD COLUMN IF NOT EXISTS bin_location VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_stock_serial_numbers_zone_layout
  ON stock_serial_numbers(zone_layout_id);
