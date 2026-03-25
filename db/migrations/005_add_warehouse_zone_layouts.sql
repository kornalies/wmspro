-- Zone > Racking > Bin layout master for put-away and future custom configuration
CREATE TABLE IF NOT EXISTS warehouse_zone_layouts (
  id SERIAL PRIMARY KEY,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  zone_code VARCHAR(30) NOT NULL,
  zone_name VARCHAR(100) NOT NULL,
  rack_code VARCHAR(30) NOT NULL,
  rack_name VARCHAR(100) NOT NULL,
  bin_code VARCHAR(40) NOT NULL,
  bin_name VARCHAR(120) NOT NULL,
  capacity_units INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_zone_layout_wh_zone_rack_bin
  ON warehouse_zone_layouts (warehouse_id, zone_code, rack_code, bin_code);

CREATE INDEX IF NOT EXISTS idx_zone_layout_warehouse_active
  ON warehouse_zone_layouts (warehouse_id, is_active);
