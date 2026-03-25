-- Stock put-away transfer audit log
CREATE TABLE IF NOT EXISTS stock_putaway_movements (
  id SERIAL PRIMARY KEY,
  stock_serial_id INTEGER NOT NULL REFERENCES stock_serial_numbers(id),
  serial_number VARCHAR(255) NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  from_zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id),
  to_zone_layout_id INTEGER NOT NULL REFERENCES warehouse_zone_layouts(id),
  from_bin_location VARCHAR(200),
  to_bin_location VARCHAR(200) NOT NULL,
  remarks TEXT,
  moved_by INTEGER NOT NULL REFERENCES users(id),
  moved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_putaway_movements_warehouse_moved_at
  ON stock_putaway_movements(warehouse_id, moved_at DESC);

CREATE INDEX IF NOT EXISTS idx_putaway_movements_stock_serial_id
  ON stock_putaway_movements(stock_serial_id);
