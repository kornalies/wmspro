-- Separate approving an inventory adjustment from raising one.
--
-- Migration 075 did this for stock transfers and left adjustments behind, even
-- though an adjustment is the more dangerous of the two: a transfer moves stock
-- between two warehouses that both belong to us, an adjustment destroys it.
-- Both raising and approving ran on stock.putaway.manage -- the permission an
-- OPERATOR already needs to do their job -- so the person who reported the
-- damage also signed off the write-off, and the approval step was decoration.
--
-- Granted to ADMIN, WAREHOUSE_MANAGER, SUPERVISOR and OPERATIONS but NOT to
-- OPERATOR. Operators raise adjustments and may withdraw their own; supervisors
-- and above approve or reject them. Existing users keep every permission they
-- had; this only adds one.

BEGIN;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES (
  'stock.adjustment.approve',
  'Approve Inventory Adjustments',
  'Authorise an inventory adjustment, writing stock off or bringing found stock in'
)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM rbac_roles r
  JOIN rbac_permissions p ON p.permission_key = 'stock.adjustment.approve'
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'WAREHOUSE_MANAGER', 'SUPERVISOR', 'OPERATIONS')
ON CONFLICT DO NOTHING;

COMMIT;
