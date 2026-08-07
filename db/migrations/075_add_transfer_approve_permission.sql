-- Separate approving a stock transfer from raising one.
--
-- Every transfer action ran on stock.putaway.manage, the permission an OPERATOR
-- already needs to do their job. So the person who raised a transfer could
-- approve it, and approval -- which since migration 072 places a real hold on
-- inventory -- was a control that anyone able to trip it could also authorise.
--
-- The new key is granted to ADMIN, WAREHOUSE_MANAGER, SUPERVISOR and OPERATIONS
-- but NOT to OPERATOR. That is the whole control: operators raise and pick,
-- supervisors and above authorise. Existing users keep every permission they
-- had; this only adds one, so nothing an operator could do yesterday breaks --
-- except approving, which is the point.

BEGIN;

INSERT INTO rbac_permissions (permission_key, permission_name, description)
VALUES (
  'stock.transfer.approve',
  'Approve Stock Transfers',
  'Authorise an inter-warehouse transfer, placing a hold on the stock'
)
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM rbac_roles r
  JOIN rbac_permissions p ON p.permission_key = 'stock.transfer.approve'
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'WAREHOUSE_MANAGER', 'SUPERVISOR', 'OPERATIONS')
ON CONFLICT DO NOTHING;

COMMIT;
