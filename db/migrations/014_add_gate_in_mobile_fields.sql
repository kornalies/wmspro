ALTER TABLE gate_in
ADD COLUMN IF NOT EXISTS lr_date date,
ADD COLUMN IF NOT EXISTS e_way_bill_date date,
ADD COLUMN IF NOT EXISTS from_location varchar(255),
ADD COLUMN IF NOT EXISTS to_location varchar(255),
ADD COLUMN IF NOT EXISTS vehicle_type varchar(50),
ADD COLUMN IF NOT EXISTS vehicle_model varchar(100),
ADD COLUMN IF NOT EXISTS transported_by varchar(20),
ADD COLUMN IF NOT EXISTS vendor_name varchar(255),
ADD COLUMN IF NOT EXISTS transportation_remarks text,
ADD COLUMN IF NOT EXISTS mobile_capture_payload jsonb;
