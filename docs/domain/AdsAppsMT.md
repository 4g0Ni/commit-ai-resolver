# AdsAppsMT — Domain Knowledge

## Business Terms

- **CampaignMT**: Campaign Management Middle Tier — the core service layer for Microsoft Advertising campaign operations (SOAP/REST API, entity CRUD, bidding, targeting, editorial)
- **PMax (Performance Max)**: Fully automated campaign type. Special handling throughout EO/DAO/import layers. Asset group CRUD, editorial status, appeal workflows.
- **FDP (Fast Data Pipeline)**: NRT/batch streaming data platform in `private/FastDataPipeline/`. Protobuf/Avro contracts per domain (CDR, FastBI, BatchBI, Billing, Conversion).
- **CDR (Click Data Record)**: Per-click event stream in `FastDataPipeline.Contract/CDR/` flowing to ClickHouse/DeltaLake.
- **DE (Data Entity)**: Campaign entity change events (protobuf) in `FastDataPipeline.Contract/DE/`.
- **V13 API**: Current public SOAP API version for Campaign Management. Source: `private/Campaign/MT/Source/API/MergedAPI/V13/`. SDK auto-generated from WSDL.
- **DAO (Data Access Object)**: Database access layer in `CampaignServiceData/Dao/`. Pattern: Interface + Implementation + SpWrappers + request/response.
- **EO (Entity Operation)**: Business logic layer in `CampaignServiceData/EO/` between service contract and DAO.
- **ROAS (Return On Ad Spend)**: Revenue metric used in bidding strategies (`BiddingScheme`, `MaxConversionValue`) and time-series anomaly detection.
- **ObjectStore**: Internal key-value store (corpnet-only). Used by aggregatorservice, campaignmt, pirodata. Config: `ObjectStoreUrlFormat`.
- **OMS (Order Management System)**: Programmatic/guaranteed media buying in `private/OrderManagementSystem/`. MediaPlan, Line, Xandr integration.
- **PIR (Performance Insights & Recommendations)**: Actionable recommendations service area: `PIRService`, `PIROData`, `PIRApi`.
- **MSF (Microsoft Service Framework)**: WCF hosting, throttling, auth pipeline in `private/MSF/`.
- **CCDB (Customer/Campaign Configuration Database)**: Pilot/feature flag store. `AccountFeatureFlag`/`CustomerFeatureFlag` IDs map to CCDB pilot slots.
- **DirectBI**: ClickHouse SQL report layer in `private/Campaign/MT/Source/DirectBI/` used by aggregatorservice.
- **BCP (Business Continuity Plan)**: Disaster recovery and failover procedures for FDP/CDR data pipelines.
- **NCA (New Customer Acquisition)**: Campaign feature for targeting new customers (`CustomerLifecycleGoal`).
- **MISE (Microsoft Identity Security Experience)**: AAD-based S2S auth middleware (`Microsoft.Identity.ServiceEssentials`) replacing legacy Hypernet VNET-isolation. Services expose port 8443 with MISE auth.
- **MSClickId (Microsoft Click ID)**: Unique click identifier for attribution tracking in performance reports.
- **MAU/MAD (MultiAccountUpload/Download)**: Bulk CSV operations via `multiaccountupload`/`multiaccountdownload` services.
- **3PSSP (Third-Party Supply-Side Platform)**: External SSP entity support in OMS MediaPlan/Line. When disabled, defaults to built-in Xandr/Monetize SSP.
- **TVP (Table-Valued Parameters)**: SQL Server pattern passing DataTable to stored procedures. Used in OMS (conditional columns per 3PSSP feature) and CampaignService (OICountryRejectionReason migration).
- **OI (OrderItem)**: Internal entity name for Keywords. `OICountryRejectionReason` table stores per-country editorial rejection reasons; being migrated to JSON column format (`OICountryRRJSON`).
- **Xandr**: DSP/ad-exchange integration for guaranteed/programmatic direct deals in OMS. MediaPlan commit creates Xandr InsertionOrder/LineItem. FastDataPipeline_Xandr streams C2C entity changes.
- **Flight Allocation**: A/B test allocation service (`FlightAllocationSvc`) based on Litmus SDK. Reads partner blob files from Azure Blob Storage with ManagedIdentity.
- **Cosmos 11**: Migrated Cosmos cluster for MRC (Microsoft Reporting Cosmos) data. cosmos11 uses `local/...` path prefix, flat date-prefixed filenames, reordered TSV columns vs legacy cosmos08.
- **Performance Prediction Score**: AI-generated ad quality score from AggregationService (AIGC). Online path: real-time via `GetPerformancePredictionScore()`. Offline path: `OfflinePerformancePredictionScoreTaskManager` backfills ads without scores.
- **Portfolio Bid Strategy**: SharedEntity automated bidding strategy (Target CPA, Target ROAS, Maximize Clicks) applied across multiple campaigns. Exposed via CampaignManagement API and OData with per-account authorization.

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/Campaign/MT/` | Campaign Management Middle Tier — core SOAP/REST API, entity CRUD, bidding, targeting, editorial |
| `private/Campaign/Datamart/` | ClickHouse analytics — ClickhouseLoader, ClickhouseJobScheduler batch ingestion |
| `private/FastDataPipeline/` | FDP — NRT/batch streaming data (CDR, FastBI, BatchBI, Billing, Conversion) |
| `private/OrderManagementSystem/` | OMS — programmatic/guaranteed media buying (MediaPlan, Line, Xandr) |
| `private/MSF/` | MSF — WCF hosting, throttling, auth pipeline |
| `private/MarTech/` | Marketing Technology — ADF pipelines, Spark jobs, coupon/email, SMB segments |
| `private/BingAdsApiSDK/` | V13 API SDK — .NET/Java/Python/PHP SDKs and OpenAPI specs |
| `private/Common/` | Shared infrastructure — Kubernetes, KeyVault, caching, ClickHouse client, GoogleSync/FacebookSync |
| `private/MultiChannelAds/` | Multi-Channel Ads — cross-channel campaign support |
| `private/Zapier/` | Zapier third-party integration |
| `private/Campaign/MT/Source/API/MergedAPI/V13/` | V13 SOAP API contracts and routing |
| `private/Campaign/MT/Source/DirectBI/` | ClickHouse SQL reporting layer |
| `private/Campaign/MT/Source/Implementation/` | Core service implementation including Dynamic.config |
| `CampaignServiceData/EO/` | Entity Operations — business logic layer |
| `CampaignServiceData/Dao/` | Data Access Objects — stored procedure wrappers |
| `Generated/` | Auto-generated API contracts and models |
| `AKS/`, `helm-*/` | Kubernetes deployment configs (infrastructure, NOT feature config) |
| `CloudTest/` | Integration test infrastructure |
| `adf-prod/` | Azure Data Factory pipelines and triggers |

## Service Inventory (On-Call Critical)

### Public-Facing Services (via Azure Front Door)

| Service | AKS Name | Purpose | Replicas |
|---------|----------|---------|----------|
| Campaign API | `campaignmt-campaignapi` | V13 SOAP/REST API (primary advertiser endpoint) | 40 |
| OData API | `campaignmt-odata` | OData REST UI gateway (BingAds UI consumption) | 15 |
| Reporting API | `campaignmt-reportingapi` | Report creation/status SOAP API | 17 |
| File Upload | `campaignmt-fileupload` | Bulk file upload endpoint | 8 |
| Order Management | `campaignmt-ordermanagement` | OMS REST API (programmatic media) | 4 |
| OneCRM Gateway | `campaignmt-onecrmgateway` | Bridge to OneCRM/TrueCRM | 4 |
| PIR API | `campaignmt-pirapi` | Performance Insights public API | 3 |

### Internal Services (Private network)

| Service | Purpose | Replicas |
|---------|---------|----------|
| `campaignmt-aggregatorservice` | **Critical**: Data fanout hub — serves all grid/BI data | 140 |
| `campaignmt-distributedqueryservice` | gRPC fanout for distributed BI queries | 36 |
| `campaignmt-campaignmt` | Core WCF service — processes entity mutations | 15 |
| `campaignmt-metadataservice` | **Critical**: System metadata — ALL 25 services depend on it | — |
| `campaignmt-taskengine` | **Critical**: Offline task execution (RulesEngine) — most services depend on it | — |
| `campaignmt-editorialsyncservice` | Syncs editorial status from EditorialMT | — |
| `campaignmt-importapp` / `importappmi` | Google/Facebook/Pinterest/Amazon import | — |
| `campaignmt-multiaccountupload` | Bulk upload processing | 42 |
| `campaignmt-multiaccountdownload` | Bulk download | 42 |
| `campaignmt-mapofferstreenodes` | Product offer tree (Shopping/PMax catalog) | — |
| `campaignmt-pirodata` | Performance Insights OData backend | — |

## API Contracts

- **V13 SOAP API**: `ICampaignManagementService` via WCF/CoreWCF. Pattern: SDK Client → MSF → ApiPipelineHelper → EO → DAO → SQL
- **OData REST API**: `/ODataApi/Advertiser/V2/` via ASP.NET Core + OData v4. Pattern: Controller → Repository → AggregatorService (WCF) → ClickHouse
- **Reporting API**: V13 SOAP. Pattern: Submit → TaskEngine queues job → ReportDataService processes → ReportDownload serves
- **FDP Contracts**: Protobuf schemas per domain in `FastDataPipeline.Contract/{Domain}/`
- **OMS REST API**: `/api/MediaPlan`, `/api/Line` via ASP.NET Core REST

## Environments

| Tag | Meaning |
|-----|---------|
| CI/CICorp | Continuous integration build environment |
| SI (`*-SI-BN2B`) | System Integration (pre-production) |
| TIP (`tip-cus`) | Traffic-in-production canary |
| BCP (`bcp-wus-ldc1`) | Business Continuity / Prod-West |
| Prod (`prod-mw1`, `prod-ch01`) | Production — Midwest / Chicago |
| EAP LDC1/2/3 | Early-adopter pilot ring |

## Infrastructure

| Component | Role | On-Call Impact |
|-----------|------|---------------|
| ClickHouse | Analytics DB (BI metrics store) | Grid data unavailable if down |
| SQL Server (sharded) | Campaign entity store | All CRUD broken if down |
| ATM (Azure Traffic Manager) | Internal service discovery (100.x/10.x) | Service calls fail if ATM resolves wrong IP |
| Azure KeyVault | Cert/secret store | Auth failures on cert rotation |
| Redis | Throttling/caching | Throttle bypass risk if unavailable |
| EditorialMT | Editorial review service | Ad disapproval data stale if editorialsyncservice can't reach it |
| ObjectStore | Large object store (corpnet-only) | AggSvc/pirodata degrade outside corpnet |
| AzureServiceBus/Queue | Task dispatch for TaskEngine | Task backlog if queue unhealthy |

## Feature Flag Patterns

- `Enable*` prefix — Feature enablement in service layer
- `Permissions.*` prefix — Account/user permission checks
- `DynamicConfig*.json` — Runtime feature toggles (`Dynamic.config` is the master config)
- `DynamicConfigValues.cs` — Typed accessors for Dynamic.config keys
- `appsettings*.json` — Environment-specific service configuration
- CCDB pilot slots — Account/Customer feature flags with percentage ramps

**Not feature config:** `helm-*.yaml`, `values.yaml` (Kubernetes deployment infrastructure), `agent/*.json` / `agent/*.md` (AI workflow definitions), AKS packaging artifacts, Dependabot image digest bumps. These are auto-skipped or classified as `code`, not `config`.

## Key Risk Signals

- V13 API contract changes can break frontend callers (breaking change)
- DAO/stored proc changes affect data integrity
- FDP/HDFS changes affect data processing reliability
- MetadataService or TaskEngine down → cascades to ALL services
- ObjectStore errors when pods lose corpnet visibility
- DynamicConfig changes take effect at runtime without redeployment
- Grid/BI data empty → check aggregatorservice + distributedqueryservice + ClickHouse

## DRI Investigation Tips

1. **MetadataService or TaskEngine down** → cascades to all services; check ATM health first
2. **Grid/BI data empty** → check aggregatorservice + distributedqueryservice + ClickHouse
3. **Editorial status stale** → check editorialsyncservice → EditorialMT dependency
4. **Import failures** → check importapp + Google/Facebook client endpoints
5. **ObjectStore errors** → pods lost corpnet visibility; affects aggregatorservice/pirodata
6. **Feature flag gating** → all runtime flags in `Dynamic.config`; `DynamicConfigValues.cs` exposes typed properties
7. **Dead config keys** → 19/68 config keys are dead code; don't chase those URLs
