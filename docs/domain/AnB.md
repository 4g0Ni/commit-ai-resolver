# AnB — Domain Knowledge

## Repository Overview

**AnB** (Ads and Bidding / Auction and Bidding) is the backend monorepo for Microsoft Advertising's **customer management, billing, and budget-control platform**. Two teams share it:

- **CCMT team** — ClientCenter Middle-Tier APIs (customer/account/billing operations and the proxy layer above them).
- **Billing team** — BillingDB, MTSpark jobs, Airflow ingestion, budget control, restatement pipelines.

It owns: customer/account/agency CRUD, billing infrastructure (payment instruments, invoices, coupons, insertion orders, revenue recognition), budget control (daily caps, monthly budgets, pause signals), Spark/Airflow ETL pipelines, and partner billing integrations (Xandr, LinkedIn, Taboola, MCA, SAP, MediaOcean).

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/ClientCenter/MT/Source/` | CCMT — all C# middle-tier business logic and the CCAPI proxy |
| `private/ClientCenter/DB/` | SQL: PartitionedCustomerDB, AppsConsolidatedDB, NotificationDB, **PCIDB** (payment cards) |
| `private/ClientCenter/Spark/` | Coupon metrics Spark SQL |
| `private/Billing/App/` | BillingDependencies service |
| `private/Billing/DB/` | BillingDB, MCABillingDB, BillingKpiDB schemas + stored procs |
| `private/Billing/MTSpark/` | ~120+ Python PySpark batch jobs (revenue, tax, reconciliation, fraud) |
| `private/Billing/Pipelines/` | Azure Synapse / ADLA Scope / T-SQL transporter jobs |
| `private/Billing/Workflows/` | Airflow 3.2 YAML-driven ingestion DAGs (Python 3.13) |
| `private/Billing/Tax/` | TaxService (.NET) |
| `private/Billing/FraudAnalysis/` | AVS fraud analysis |
| `private/Billing/XandrBillingHourlyJobs/` | Java/Scala Spark jobs for Xandr billing |
| `private/Common/Microsoft.BingAds.AnB.FlipManager/` | BCP flip state machine |
| `private/Common/Microsoft.BingAds.Billing.Daos/` | Billing DAO layer |
| `private/Common/Microsoft.BingAds.AnB.PartnerClient.*/` | BCentral, FCA, MMAIS, OneVet, Onfido, UCM partner clients |
| `docs/ccmt/`, `docs/ccapi/`, `docs/database/Budget/`, `docs/database/pipelines-restatement/` | Architecture references |

## Service Inventory

### CCAPI (`private/ClientCenter/MT/Source/API/`)
External-facing **WCF SOAP + REST API** layer. **Pure translation proxy — no business logic.** Two parallel versions must be updated together:
- **V13Core** — MSF-hosted (primary)
- **v13** — legacy WCF self-hosted

Two service families: `CustomerManagementService` and `CustomerBillingService`.

Request pattern: `WcfService → Pipeline (auth/throttle) → Operation<TApiReq,TApiResp,TMtReq,TMtResp> → Translator → CCMT channel`

### CCMT (`private/ClientCenter/MT/Source/ClientCenter/`)
Core business logic middle tier (C#/.NET WCF). Layers:
- **ServiceImpl** — 20+ partial `MiddleTierService_{Domain}.cs` files; each method dispatches to a BO
- **BO** (Business Operations) — orchestrates workflow, sets context, calls EO
- **EO** (Entity Operations) — domain logic, validation, DAO calls; 25+ domain directories
- **Validation** — per-domain `IValidation<TReq, TDependencyData>` returning `SenderError` lists
- **DAO** — wraps individual stored procedure calls
- **EntityDataAccessor** — repository pattern composing multiple DAOs
- **Cache** — Redis distributed + in-memory (accounts, customers, users)
- **Proxy** (`Proxy/ClientCenterProxy.cs`) — 60K-line auto-generated WCF proxy; rebuilt when interface changes

### JobProcessor (`private/ClientCenter/MT/Source/ClientCenterJobProcessor/`)
Async background queue. Key processors: `BillMeNowJobProcessor`, `CLEProcessActionsJobProcessor`, `CreditAndRebillJobProcessor`, `NotificationServiceJobProcessor`, `DelayedActionServiceJobProcessor`, `InsertionOrderUploadProcessor`, `MSAClosureJobProcessor`, `XandrAccountDLQHandler` (ServiceBus DLQ).

### BillingDB (`private/Billing/DB/BillingDB/`)
Central billing SQL database. Owns SPs for: campaign/account budget daily-cap calculation, monthly budget calc, budget control (CAS pattern on balances), insertion order balance, restatement (`prc_CommitRestatementData`, `prc_FetchRestatementRows`, `prc_PreserveCampaignBalances`, `prc_PreserveInsertionOrderBalances`), 19 `prc_Monitor_*` SPs.

### MTSpark (`private/Billing/MTSpark/`)
~120+ Python PySpark jobs on Magnetar/Synapse. Categories: revenue reporting (`bingads_revenue`, `mca_ps_revrec_monthly`, `rrso_*`), reconciliation (`ms_adjustment_reconcile`, `tq_*_reconcile`, `xandr_bi_reconcile_*`), tax (`mdigital_service_tax`, `consolidated_tax_report`, `onetax`), coupon analytics, fraud (`events_for_fraud_detection`, `tq_fraud_adjustments_agg`), insertion order (`merge_insertion_order`, `expire_io_recommendation`, `will_exhaust_io`), Xandr billing.

### Billing Workflows (`private/Billing/Workflows/`)
**Airflow 3.2.0** YAML-driven ingestion (Python 3.13+). DAG factory reads `config/ingestion/*.yaml` and generates one DAG per table. Sources: MySQL, SQL Server. Sink: ADLS Delta Lake. Auth: Azure Workload Identity only. Tech: Pydantic v2, pandas/pyarrow.

### Xandr Billing Hourly Jobs
Java/Scala Spark for Xandr (SSP) billing: hourly unified billing, monthly reconciliation, receivables, revenue.

## Feature Flag Patterns

| Mechanism | Location | Scope |
|-----------|----------|-------|
| **DynamicConfig** | `ClientCenter/MT/Source/ClientCenter/DomainData/DynamicConfigValues.cs` + `appsettings.json` | CCMT runtime config |
| **CCAPI DynamicConfig** | `V13Core/Shared/DynamicConfig.cs` | API-level gating (e.g., REST enablement) |
| **PilotFeature** | `Feature.cs` + `PilotFeature` DB table | Per-customer/account flags checked at EO layer |
| **Request Flags** | `Request.RequestDetails` | Per-request override flags |
| **BCP FlipManager** | `private/Common/Microsoft.BingAds.AnB.FlipManager/FlipManager.cs` + BCP DB | Blue/green flip state for Billing pipelines (SI/PROD active env) |
| **Airflow env files** | `private/Billing/Workflows/config/environments/<env>.env` | Per-env config (SI/PROD/BCP) |
| **Sangam/Scope** | `private/Billing/Pipelines/Sangam.props` | ADLA/Cosmos job configuration |

## Common Change Types

| Change Type | Files |
|-------------|-------|
| New CCMT operation | `DataContract/` + `BO/` + `EO/` + `Validation/` + `MiddleTierService_*.cs` dispatch |
| New CCAPI endpoint | `Operation<>` + `Translator` + `*PipeLine.cs` + `*Service.cs` + `*MessageContracts.cs` + DI in **both** v13 and V13Core |
| Proxy update | Regenerate `Proxy/ClientCenterProxy.cs` (~60K-line diff) |
| DB schema change | New/altered table or SP in `private/ClientCenter/DB/` or `private/Billing/DB/` |
| Error code | `SenderErrorCode_*.cs` + mapping in `ClientCenterMTErrorMapping.cs` |
| Tax / country expansion | `CountryTax` table + VAT regex + flag in `Feature.cs` |
| MTSpark job | New Python file in `private/Billing/MTSpark/` + possibly `bingmt_jobs.json` |
| Airflow pipeline | YAML in `config/ingestion/*.yaml` or new `TaskBuilder`/source/sink in `plugins/core/` |
| BillingDB SP | SQL file in `private/Billing/DB/BillingDB/` — usually budget/balance/restatement logic |
| DynamicConfig flag | `DynamicConfigValues.cs` + `appsettings.json` (CCMT) or `DynamicConfig.cs` (CCAPI) |
| Coupon operation | `EO/Coupon/` or `EO/CouponV2/` + `MiddleTierService_Coupon.cs` |
| Xandr integration | `EO/Xandr/` or `EO/XandrSeller/` + Java jobs in `XandrBillingHourlyJobs/` |
| LCID / language | `DataContract/Entity/Enums.cs` + `LanguageType.cs` + `CommonTranslator.cs` (3-file pattern) |
| AIV (identity verification) | `EO/AccountVerification/` |
| Restatement pipeline | ADF Spark + BillingDB SPs (`prc_CommitRestatementData`, etc.) |

## Key Risk Signals

- **`Proxy/ClientCenterProxy.cs`** — 60K-line auto-generated; a bad regeneration silently breaks all CCMT ops.
- **v13 + V13Core dual update** — every new CCAPI endpoint must land in **both**; missing one causes inconsistent behavior across routing paths.
- **BillingDB restatement SPs** (`prc_CommitRestatementData`, `prc_PreserveCampaignBalances`, `prc_PreserveInsertionOrderBalances`) — silent miscredits/debits if buggy.
- **Budget-control CAS** — concurrent updates fail silently on CAS mismatch; wrong campaign pause signals ripple to ad delivery.
- **Cache invalidation** — stale Redis on accounts/customers causes incorrect billing or auth decisions.
- **BCP FlipManager** — wrong flip points billing jobs at wrong data shards.
- **MTSpark `bingmt_jobs.json`** — JSON manifest registering all Spark jobs; controls what runs in prod.
- **DynamicConfig rollout** — CCMT feature flags affect all accounts instantly; verify killswitch exists.
- **IO balance SPs** — incorrect balance triggers unexpected pauses or overspend for prepay advertisers.
- **Xandr integration** — billing errors here affect publisher payouts and SLAs.
- **Tax / compliance** — India e-invoicing (`EO/IndiaEInvoicing/`), Brazil/France e-invoicing (`EO/ModernEInvoicing/`), trade screening (`EO/TradeScreening/`) — regulatory risk.
- **PCIDB schema** — payment-card data; any change carries compliance risk.

## Key Acronyms

| Term | Definition |
|------|------------|
| **AnB** | Ads and Bidding (repo name); also "Auction and Bidding" |
| **CCMT** | ClientCenter Middle Tier — .NET WCF business-logic service |
| **CCAPI** | ClientCenter API — WCF/REST proxy above CCMT |
| **BO / EO / DAO** | Business Operation / Entity Operation / Data Access Object layers |
| **IO** | Insertion Order — prepay contract with spend cap + time window |
| **FAC** | Fully Automated Coupon |
| **MIO / SAP** | Monthly Invoice Onboarding / SAP enterprise billing |
| **BCP** | Business Continuity Plan — blue/green flip mechanism |
| **MTSpark** | Magnetar Spark — Microsoft internal distributed compute |
| **MZ** | Monetization Zone — ad-delivery data feeding billing |
| **TQ** | Transaction Queue — billing transaction stream |
| **RevRec** | Revenue Recognition — LTD/MTD spending accounting |
| **RNR** | Revenue and Reporting weight (0.0–2.0) for budget cap smoothing |
| **CAS** | Compare-And-Swap — optimistic concurrency in SQL balance updates |
| **MTD / LTD** | Month-to-Date / Lifetime-to-Date balance |
| **RRSO** | Revenue Recognition Summary Order — GL rollup |
| **ADLS** | Azure Data Lake Storage Gen2 — Airflow ingestion sink |
| **AIV** | Advertiser Identity Verification |
| **LCID** | Locale ID (e.g., `1045` = Polish) |
| **SenderFaultException** | CCMT validation exception → `SenderErrorCode` |
| **PilotFeature** | DB-stored customer-level feature flag |
| **DynamicConfig** | Runtime config flag — no redeploy needed |
| **Xandr** | SSP partner (formerly AppNexus) — CCMT `EO/Xandr*` + Java hourly jobs |
| **BatchId** | `DATEDIFF(SECOND, '1995-12-31', SlotTime) + Version` — restatement batch identifier |
| **RestatementDelta** | SystemParameter defining current restatement processing window |
| **Flip** | BCP environment-switch via FlipManager |
| **V13Core / v13** | Parallel CCAPI versions (MSF-hosted vs WCF self-hosted) — update together |
| **MCA** | Microsoft Customer Agreement — modern self-serve billing model |
| **MSAN** | Microsoft Advertising Network |
| **FX / EXRATE** | Foreign exchange rate for multi-currency billing |
| **GL** | General Ledger — downstream of billing pipeline |
| **DWC** | Data Warehouse Cloud — event management system |
| **ADF** | Azure Data Factory — Spark/pipeline orchestration |
| **ADX / Kusto** | Azure Data Explorer — telemetry, logs, billing analytics |

## DRI Investigation Tips

1. **CCMT operation broken after deploy** → check `ClientCenterProxy.cs` regeneration; verify v13 + V13Core parity.
2. **Account incorrectly paused / overspent** → BillingDB budget-control + IO balance SPs; check CAS contention.
3. **Wrong balances after a backfill** → restatement SP suite; check `prc_PreserveCampaignBalances` + batch IDs.
4. **Spark job missing in prod** → `bingmt_jobs.json` manifest registration.
5. **Airflow ingestion gap** → check `config/ingestion/*.yaml` + env file in `config/environments/`.
6. **Billing logic flipped unexpectedly** → CCMT `DynamicConfig` rollout; cross-check `Feature.cs` PilotFeature flags.
7. **Cross-shard billing routing wrong** → `FlipManager` state in BCP DB.
8. **Stale customer/account state** → Redis cache TTL + invalidation; check recent EO cache changes.
