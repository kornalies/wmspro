# 90-Minute Tenant Implementation Playbook

## Objective
Bring a new small/mid 3PL tenant to usable state in 90 minutes with standard configuration.

## Time Box
1. 0-10 min: Company + Warehouse
2. 10-25 min: Clients
3. 25-40 min: Item Master Import
4. 40-50 min: Users + Roles
5. 50-65 min: Contract Setup
6. 65-75 min: Billing Profiles
7. 75-85 min: Portal Mapping
8. 85-90 min: Smoke Test

## Detailed Steps
1. Company + Warehouse
   - Open `/admin/companies` and verify tenant metadata.
   - Open `/admin/warehouses` and create at least one active warehouse.
2. Client Setup
   - Open `/admin/clients`.
   - Import/create active client records.
3. Item Master
   - Use `/templates/items_template.csv`.
   - Load item master through existing admin item setup.
4. User Provisioning
   - Open `/admin/users`.
   - Create operations, gate, finance, and client users.
5. Contract and Rates
   - Open `/finance/contracts`.
   - Configure rate cards and effective dates.
6. Billing
   - Open `/finance/billing`.
   - Configure billing profile per client.
7. Portal Access
   - Run auto-seed from `/admin/onboarding`.
   - Validate `/portal` for at least one mapped user.
8. Smoke Test
   - Create one Gate In.
   - Create one GRN.
   - Process one DO.
   - Validate portal visibility for mapped client.

## Go/No-Go Checklist
1. At least one active warehouse.
2. At least one active client.
3. Item master loaded.
4. At least two active users (admin + operations).
5. At least one active contract.
6. At least one active billing profile.
7. Portal mapping active.
