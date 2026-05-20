# AdsAppsDB (CMDB) — Domain Knowledge

## Repository Overview

**AdsAppsDB** (a.k.a. **CMDB — Campaign Management Database**) is the authoritative source-of-truth for all Microsoft Advertising campaign data. It owns SQL table DDL, stored procedures, indexes, triggers, SQL Agent jobs (`.sqt`), reference/seed data, migrations, build manifests, runtime parameters, unit tests, and CI/CD pipelines.

Covers **OLTP campaign management** (campaigns, ad groups, ads, ad extensions, budgets, bid strategies, targeting), **batch extract pipelines** (delta/full dumps to FDP/CDR consumers), **DSP** entities, **Billing/BI datamarts**, and **Planner/ClickHouse** analytics.

## Folder-to-Domain Mapping

```
private/
├── Campaign/
│   ├── DB/Source/                    Core OLTP databases (see DB Families below)
│   ├── MT/Source/Shared/             Microservice/tool shared code
│   └── DB/Deployment/                CI_UT, CopyBuild scripts
├── Common/
│   ├── DB/                           Shared: SchemaModificationFramework,
│   │                                   StagingAreaFramework, ExtractFramework,
│   │                                   CommonUtils, AzureMaintenance
│   └── AzureMonitoringSystem/
├── Datamart/
│   ├── AdCenterBI_WD/                Warehouse delivery
│   ├── AuditHistoryBI/               Change-history BI pipeline
│   ├── BillingDB/                    Billing datamart (Cosmos/Scope)
│   ├── Clickhouse/                   ClickHouse analytics
│   ├── PlannerClickhouse/            Planner ClickHouse
│   ├── TaskHub/                      Async task dispatch
│   └── BingAdsKPI/                   KPI metrics
├── Pipelines/                        ADO YAML pipelines (daily, hotfix, DSP, BI)
└── Tools/LogPolicyConfiguration/
```

Within each DB folder: `Schema/Table/Table/*.sql`, `Schema/Procedure/*.sql`, `Schema/Table/Index/*.sql`, `Schema/Table/Trigger/*.sql`, `Schema/Job/*.sqt`, `Data/*.sql`, `Parameters/SystemParameters_*.sql`, `Build/*.lst`, `UT_*/`, `UnitTests/`.

## DB Families & Sharding Model

| Family | Databases | Purpose |
|--------|-----------|---------|
| **OLTP Main Shard** | `CampaignDB` | Customer/Account/Campaign master; ~1053 SPs, ~800 tables |
| **OLTP AdGroup Shard** | `CampaignAdGroupShardDB` | Partitioned ads/keywords/assets; ~653 SPs |
| **OLTP Library Shard** | `CampaignLibraryShardDB` | Shared keyword/exclusion lists; ~120 SPs |
| **OLTP Task Engine** | `CampaignBulkDB` | Throttling, offline task queue, bulk ops; ~55 SPs |
| **OLTP OMS** | `OrderManagementSystemDB` | Calendar slot booking, Xandr sync; ~76 SPs |
| **DSP Shards** | `DSPMainShardDB`, `DSPAdGroupShardDB`, `DSPLibraryShardDB` | Demand-Side Platform |
| **Admin (Batch Extract)** | `AdminMainShardDB`, `AdminAdGroupShardDB`, `AdminAdExtensionShardDB`, `AdminLibraryShardDB` | Read-only replicas; delta/full dump SPs for FDP/C2C |
| **Infrastructure** | `AzureStagingArea` | C2X/C2C load-balancing, PubSub staging |
| **Support DBs** | `UndoDB`, `ImportDB`, `RecommendationDB`, `AdsRepositoryDB`, `VerticalDB`, `MultiChannelAdsDB`, `OrderManagementSystemCustomerDB` | Undo/history, import staging, recommendations |
| **Admin Multi-channel** | `AdminMultiChannelAdsDB`, `AdminMultiChannelAdsSystemDB` | Multi-channel/MSAN |

### Sharding

- **Main shard** (`CampaignDB`) — single logical DB holding Customer, Account, Campaign, Budget, BidStrategy, AdExtension, Geo reference, lookups.
- **AdGroup shards** — physically replicated across N instances, partitioned by `AccountId`. `ShardGroupHistogram` and `AccountAdvertiserCustomer` map account → shard.
- **`ShardGroupId`** in `dbo.SystemParameters` (`ParameterName='ShardGroupId'`, `ParameterType='Environment'`) identifies the current shard instance.
- `prc_InsertUpdateAccountAdvertiserCustomerInPresentShardGroup` assigns accounts using `ShardGroupHistogram` with `DBTypeId=221` (AdGroup shard type).
- **Admin shards** are read-only replicas for batch dumps; mirror OLTP schemas but only host `SELECT`-heavy dump SPs.

### Schema Namespaces

- `dbo` — primary objects
- `migration` — migration tables & SPs (`migration.prc_*`)
- `servicepack` — service-pack-era tracking
- `infra` — infrastructure/purge utilities

## Build Manifests & Deployment

| File | Purpose |
|------|---------|
| `CampaignDB_Incremental.lst` | **Primary daily deploy** — ordered `#include` list of all schema changes |
| `CampaignDB_Hotfix.lst` | Emergency hotfix — ad-hoc data fixes, direct `UPDATE`/`INSERT` |
| `CampaignDB_Incremental_Jobs.lst` | SQL Agent job changes |
| `CampaignDB_Hotfix_Jobs.lst` | Job hotfixes |
| `CampaignDB_MainShardInit.lst` | New main-shard initialization |
| `CampaignDB_AdGroupShardInit.lst` | New AdGroup shard initialization |
| `Build/Incremental.lst` (per DB) | Each DB has its own incremental list |

Standard `.lst` entry pattern:
```
--Date Added MM/DD/YYYY
--Change Description: <what it does>
--Added by: <alias>
#include "Schema\Procedure\prc_MyNewProc.sql"
```

### Pipelines

| Pipeline | Trigger | Coverage |
|----------|---------|----------|
| `CampaignDBDailyDeployment.yml` | Nightly | All Campaign + BI + Planner DBs |
| `[BingAds][CampaignDB]-HotFix-1ESPT.yml` | Manual | Campaign hotfix path |
| `DSPDBDailyDeployment.yml` | Nightly | DSP shard DBs |
| `AdsAppsDB-master-rolling-1ESPT/` | Rolling CI | Build + unit tests |
| `CampaignDBFFTP.yml` | Manual | Fast-Forward to Production |
| `CampaignDBCodeCoverage.yml` | Scheduled | Test coverage |

Deploy command: `Deploy -filePath "Build/Incremental.lst" -shardId 0 -podPrefix '<pod-prefix>'`

### Runtime Toggles

| Mechanism | Where | Used For |
|-----------|-------|----------|
| `dbo.SystemParameters` | per DB | Per-environment values (`ShardGroupId`), feature rollout phases, cache TTLs |
| `dbo.PilotCustomerFeature` | CampaignDB | Per-customer pilot flags |
| `dbo.CustomerOptInFeature` | CampaignDB | Customer opt-in flags |
| `Parameters/SystemParameters_*.sql` | per DB | One-time `SystemParameters` inserts/updates |
| `Parameters/DynamicParameters.sqt` | CampaignDB | SQL Agent job dynamic config |
| `SystemParameters_ShardGroupPilotBitMask.SQL` | CampaignDB | Shard-group pilot bitmask for rolling shard migrations |

## Common Change Types

| Change Type | Typical Files |
|-------------|---------------|
| New stored procedure | `Schema/Procedure/prc_MyProc.sql` + `#include` in `Incremental.lst` |
| SP signature change (version bump) | New `prc_MyProc_V{N+1}.sql`; keep old version live |
| New table | `Schema/Table/Table/MyTable.sql` + optional Index/Trigger + `Incremental.lst` |
| New index | `Schema/Table/Index/MyTable.sql` + `Incremental.lst` |
| Alter table (add column) | `ALTER TABLE` guard in table SQL + `Incremental.lst` |
| Reference data | New file in `Data/` (e.g., `OrderSetting.SQL`) + `Incremental.lst` |
| Migration sproc | `migration.prc_Migrate*.sql` + optional tracking table |
| System limit change | `Data/AccountCustomSystemLimit_*.sql` + `Incremental.lst` |
| SystemParameters change | `Parameters/SystemParameters_*.sql` via `Incremental.lst` |
| SQL Agent job | Modify `.sqt` file + `CampaignDB_Incremental_Jobs.lst` |
| Hotfix data fix | Direct `UPDATE`/`INSERT` in `CampaignDB_Hotfix.lst` (verify idempotency) |
| NOLOCK removal (DTRT) | Remove `WITH (NOLOCK)` from transactional reads |
| Performance hint | Add `INNER LOOP JOIN`, `OPTION (MAXDOP 1, FORCE ORDER)`, `FORCESEEK`, `MAX_GRANT_PERCENT` |

## Key Risk Signals

### Lock Contention
- **Queue tables** (`EditorialQueueItem`, `StatusQueue`, `MatchTypeQueue`, `FeatureQueue`, `MigrationOrdersQueue`) — high-frequency insert/dequeue; lock escalation risk.
- **`ShardGroupHistogram` triggers** — INSERT/UPDATE triggers fire `INNER LOOP JOIN` against `AccountAdvertiserCustomer`; use `MAXDOP 1` + `FORCE ORDER` to avoid parallel lock storms.
- **`Campaign`, `Account`, `AccountEx`** — multiple `FOR INSERT` triggers cascade updates; schema-touching changes have high blast radius.

### Breaking Sproc Signature Changes
- **Never alter parameter order/type** of versioned SPs (`prc_Public*_V{N}`). Callers pin to specific versions. Pattern: add `prc_Public*_V{N+1}.sql`, keep `_VN` alive until callers migrate.
- **`@CheckWriteLock` on `prc_ValidateAccount`** — wrong value causes silent dirty reads or missing write-lock acquisition under concurrent load.

### Sharding Pitfalls
- **Cross-shard routing** — if `ShardGroupId` is stale after a migration, `prc_InsertUpdateAccountAdvertiserCustomerInPresentShardGroup` silently no-ops; accounts end up unrouted.
- **Shard-only SP deployed to main** — `prc_ValidateAccountInShard` doesn't exist in CampaignDB; deploying it there causes OBJ_NOT_FOUND.
- **`DBTypeId` constants** — hardcoded in many SPs (e.g., `221` for AdGroup shard); wrong value silently skips accounts in histogram lookups.

### Index Changes on Hot Tables
- Adding an index `WITH (ONLINE = OFF)` on `Campaign`, `OrderItem`, or `AdExtension` blocks reads/writes during build. Always `ONLINE = ON`.
- Dropping/rebuilding clustered indexes on partitioned tables during business hours causes partition-switch failures.

### NOLOCK Removals (DTRT)
- Removing `WITH (NOLOCK)` from a high-read SP can introduce blocking under RCSI/serializable; monitor wait stats post-deploy.

### Migration Sprocs Left Running
- `migration.prc_*` are long-running backfills; can deadlock with deploy scripts. Check `migration.*` tracking tables before deploy.

### Hotfix `.lst` Idempotency
- Direct `UPDATE`/`INSERT` in `CampaignDB_Hotfix.lst` re-runs on every hotfix deploy. Missing `IF NOT EXISTS` / `WHERE NOT EXISTS` guards causes duplicate-key violations on re-run.

## Key Acronyms

| Term | Meaning |
|------|---------|
| **CMDB** | Campaign Management Database — this repo |
| **CampaignDB** | Main-shard OLTP DB (single instance per env) |
| **AdGroupShard** | Horizontally sharded DB (ads, keywords, assets, ad groups) |
| **AdminDB** | Read-only replicas for FDP/CDR batch dumps |
| **FDP** | Feed Data Pipeline — downstream Admin-dump consumer |
| **CDR** | Change Data Record — row-level change feed from dump SPs |
| **C2C / C2X** | Cloud-to-Cloud / Cloud-to-X — cross-DC replication via `AzureStagingArea` |
| **Dump SPs** | `Prc_Dump*_Delta` / `Prc_Dump*_Full` in AdminDB |
| **DTRT** | "Do The Right Thing" — initiative to remove `WITH (NOLOCK)` from transactional reads |
| **TVP** | Table-Valued Parameter |
| **ShardGroupId** | Current shard instance identity in `SystemParameters` |
| **ShardGroupHistogram** | `FromAccountId → ShardGroupId` routing table |
| **AAC** | `AccountAdvertiserCustomer` — canonical account-to-shard routing |
| **DSP** | Demand-Side Platform |
| **OMS** | Order Management System (`OrderManagementSystemDB`) |
| **OrderItem** | Legacy schema name for "Ad" |
| **LifeCycleStatusId** | Soft-delete column on most entity tables |
| **prc_Public*** | Public-facing SPs callable from CampaignMT service |
| **prc_ValidateAccount** | Mandatory first call in OLTP SPs; write-lock if `@CheckWriteLock=1` |
| **prc_HandleError** | Universal `CATCH`-block error handler |
| **prc_TraceSpStarted / prc_TraceSpCompleted_V3** | SP-level telemetry entry/exit |
| **SystemParameters** | Key-value config table |
| **PilotCustomerFeature** | Per-customer feature enrollment |
| **AzureStagingArea** | Infrastructure DB for load-balancing, PubSub, C2C |
| **RSA / DSA / UET** | Responsive Search Ad / Dynamic Search Ad / Universal Event Tracking |
| **Xandr** | Former AppNexus; integrated via OMS for programmatic slot booking |
| **BCP** | Bulk Copy Program (used in archive jobs `BCPOut*.sqt`) |
| **MSAN / Planner** | Microsoft Advertising Network / planning tooling |
| **1ESPT** | 1ES Pipeline Templates — Microsoft's standardized ADO pipeline framework |
| **ICM** | Incident Management — `AccountCustomSystemLimit_ICM_*.sql` are incident-tied limit overrides |
| **OLTP** | Online Transaction Processing — write-path CRUD DBs |
| **Batch Extract** | Read-heavy dump DBs (AdminMainShardDB, AdminAdGroupShardDB) — no TRY/CATCH, no account validation |

## Commit Classification Cheat-Sheet

```
Incremental.lst modified                Schema/SP/data change in daily deploy
Hotfix.lst modified                     Emergency fix (check idempotency!)
migration.prc_* added                   Long-running backfill (lock contention risk)
prc_Public*_V{N+1} added                New SP version (verify old version still alive)
Schema/Table/Index/*.sql added          Index addition (verify ONLINE = ON)
Data/AccountCustomSystemLimit_*         System limit override (often ICM-triggered)
Parameters/SystemParameters_*           Runtime toggle / env config change
AdminMainShardDB/Procedure/**           Batch dump SP change (affects FDP consumers)
AzureStagingArea/**                     C2C/load-balancing change
DSP*ShardDB/**                          DSP pipeline change
```

## DRI Investigation Tips

1. **Schema deploy failure** → check `Incremental.lst` ordering and missing `#include`.
2. **Hotfix re-run failure** → idempotency guard missing in `Hotfix.lst`.
3. **Account-not-routed** after shard move → verify `ShardGroupId` and `ShardGroupHistogram` consistency.
4. **Cross-shard SP not found** → check whether shard-only SP was accidentally deployed to main, or vice versa.
5. **Deadlock during deploy** → migration SP may still be running; check `migration.*` tracking tables.
6. **Read blocking after NOLOCK removal** → monitor wait stats and isolation level.
7. **Dump SP signature break** → FDP consumers downstream; coordinate with AdsAppsMT team.
