# AdsAppUI — Domain Knowledge

## Repository Overview

AdsAppUI is the shared UI platform and infrastructure layer for Microsoft Advertising. It runs a **dual-stack architecture**: `private/UI/` (ASP.NET Framework / net472) and `private/UICore/` (ASP.NET Core / .NET 10+). Any business logic change must be mirrored to both stacks. A handful of newer apps live in the Framework stack only and have no UICore counterpart yet (see Folder Mapping).

## Business Terms

- **CCUI (Client Center UI)**: Account/billing portal in `private/UI/ClientCenter/Root/`
- **CMUI / CAP (Campaign Management UI)**: Campaign management in `private/UI/CampaignUI/`
- **MT (Middle Tier)**: Backend WCF services (CampaignManagement.MiddleTier, ClientCenter MT)
- **CCMT (ClientCenter Middle Tier)**: Proxy namespace `Microsoft.Advertiser.ClientCenter.MT.Proxy`
- **OMS (Order Management System)**: Flight/feature flag alias in `sharedfeatures.config`
- **PMax (Performance Max)**: Automated campaign type
- **PMaxLite / PMax Lite**: Simplified PMax signup/onboarding flow served by the `PMaxLiteLanding` app (`private/UI/PMaxLiteLanding/`). Routed for marketing sources including Edge coupon, Boost, BingPlaces, and FY25 PMaxLite landing flows. Gated by `AllowedFeature.PMaxLite` (1268), with sub-pilots `BingPlacesPmaxLite` (1320), `PmaxLiteBudgetSuggestion` (1455), `PMaxLiteGoalBasedSignup` (1731).
- **ESC (Expert Signup Center)**: SmartPage expert-level signup flow
- **ESCG / ESC Globalization**: ESC market-expansion suite of flags — `ESCGlobalization` (1136), `ESCPrepay` (1139), `ESCMsan` (1235). Config keys `ESCGlobalizationENMarkets` / `ESCGlobalizationNonENMarkets` control which markets are eligible.
- **EscgConfig**: Serialized ESC globalization configuration object passed to client context.
- **ESCGoogleImport**: ESC post-signup flow that redirects UnifiedSmart accounts to Google import wizard (`IsEscGoogleImportPostSignupFeatureOn`).
- **UP (Unified Product)**: Unified signup flow
- **DMC (Direct Mail Campaign / Digital Marketing Center)**: Originally a signup flow variant; also the broader Digital Marketing Center product served via the `DmcTeams` app (Teams/co-management sub-page) and Multi-Channel Ads experience.
- **MCA (Multi-Channel Ads)**: Customer scope (`UIAppScope.MultiChannelAds`) for DMC customers. Served by the standalone `McaUI` shell (`Views/Mca.cshtml`). Distinct from the older internal "Microsoft Advertising Academy" usage — current McaUI namespace targets Multi-Channel Ads / DMC customers.
- **SAP**: Third-party billing system integration in MonthlyInvoice/PAAS flows
- **PAAS (Partner As Advertiser System)**: Google/Meta/Facebook partner advertiser flows
- **ABL (Advertising Billing & Localization)**: Tax and billing localization
- **DSP (Demand-Side Platform)**: Programmatic ad buying UI in `private/UI/DspUI/`
- **SubscriptionAds**: Self-contained signup landing in `private/UI/SubscriptionAds/`. Uses `DisableRequireSelectedCustomerFilter` — no account context required to render.
- **MUID (Microsoft User ID)**: Anonymous cookie for flighting bucket allocation
- **MAP (Microsoft Advertising Platform)**: Broader platform name
- **AIV (Ad Intelligence Verification)**: Pre-submission validation checks for ads
- **DRI (Directly Responsible Individual)**: On-call engineer
- **EVT (Environment Verification Tests)**: Post-deployment health checks — HTTP-based (PowerShell), Selenium C# browser tests, and JS/Mocha tests. Scripts in `private/CloudTest/Scripts/`
- **BiData**: WCF proxy data contract carrying runtime BI metrics (clicks, impressions, AveragePosition, spend, CPC, CPA). A partial class shim in `BiDataAveragePosition.cs` re-exposes `AveragePosition` after proxy regeneration broke the property.
- **BCP (Business Continuity Planning)**: Central US (CUS) failover deployment. AKS Helm overrides control BCP pod replica counts independently from primary WestUS cluster. Under-scaled BCP = risk during WestUS outages.
- **BI (Business Intelligence)**: Two systems — runtime `IBusinessIntelligenceData`/`BIData` powering campaign grid columns, and offline SCOPE scripts in `private/Tools/Metrics/` for operational dashboards. The next-gen reporting backend is tracked as **ClickHouseP2** (1297).
- **NavigationRefresh** (1272): Redesigned navigation shell.
- **UnifiedDiagnosticCard**: Unified diagnostic UX — pilots `ForSearchCampaigns` (1708) and `All` (1709).
- **AssetLibraryAIGC** (1276): AI-Generated Content in Asset Library.
- **PerformancePredictionScore** (1751): AI-based campaign performance scoring.
- **MMA (Multi-Media Ads)**: `PmaxMMAAdStrength` (1734) measures ad strength for PMax MMA campaigns.
- **Amplify (UET)**: Analytics/tracking script (`AmplifyTrackingScriptUrl`) served from Azure Front Door CDN; injected into every page context.
- **BingPlaces (BP)**: Bing Places local-business import integration; uses its own OAuth2 controller (see Auth Pipeline).
- **CcuiBlobStorage**: Azure Blob Storage URI for CCUI static data assets.

## Dual-Stack Architecture

| Stack | Path | Framework | Deployment |
|-------|------|-----------|------------|
| Legacy | `private/UI/` | ASP.NET Framework (net472) | Azure Cloud Service (`.cscfg`/`.csdef`) |
| Core | `private/UICore/` | ASP.NET Core (.NET 10) | AKS via Helm (`helm-netcore`) |

**Mirror rule**: Every change in `private/UI/...` with shared business logic **must** be applied identically to `private/UICore/...`. Differences are limited to HTTP context APIs:
- Legacy: `HttpContextBase`, `System.Web`, `httpContext.Request.Cookies["x"].Value`
- Core: `HttpContext`, `Microsoft.AspNetCore.Http`, `httpContext.Request.Cookies["x"]` (returns string directly)

A few apps (`McaUI`, `DmcTeams`, `SubscriptionAds`, `PMaxLiteLanding`, `ScSupport`, `UpSupport`) currently live in the Framework stack only and have no UICore mirror.

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/UI/WebUI/` | Login / Root Page — entry point, `RootPageController` |
| `private/UI/ClientCenter/Root/` | ClientCenter (CCUI) — account management, billing, invitations |
| `private/UI/ClientCenter/Support/` | SupportUI — internal Microsoft support tooling |
| `private/UI/CampaignUI/` | Campaign Management (CMUI) — ad campaign CRUD, reporting |
| `private/UI/SmartPage/` | SmartPage Signup — ESC, UP, DMC signup flows |
| `private/UI/PMaxLiteLanding/` | Performance Max Lite acquisition landing (Framework-only) |
| `private/UI/ReportingUI/` | Reporting — AdCenter reporting grid, metrics |
| `private/UI/DspUI/` | DSP UI — Demand-Side Platform |
| `private/UI/McaUI/` | MCA UI — Multi-Channel Ads (DMC) customer shell (`Microsoft.Advertising.UX.McaUI`, Framework-only) |
| `private/UI/DmcTeams/` | DmcTeams — Teams/co-management sub-page inside DMC (`Microsoft.Advertising.UX.DmcTeams`, Framework-only) |
| `private/UI/SubscriptionAds/` | Subscription Ads products / self-contained signup landing (`Microsoft.Advertising.UX.SubscriptionAds`, Framework-only) |
| `private/UI/ScSupport/`, `private/UI/UpSupport/` | Internal support tools (Framework-only) |
| `private/UI/Common/` | Shared platform libs (see Platform Components) |
| `private/UI/Platform/` | Framework controls, library |
| `private/UI/Assets/clientcenter/` | ClientCenter SPA (React) webpack bundles |
| `private/UI/Assets/campaignui/` | CampaignUI SPA webpack bundles |
| `private/UI/Localization/` | strings.resx for all i18n |
| `private/UICore/*/` | .NET Core mirrors of the apps above (where a mirror exists) |
| `/loc/` | Localization resource files |
| `/helm-netcore/` | Kubernetes deployment configs for .NET Core services |
| `/sharedfeatures.config` | Shared feature flag configuration |

## Shared Platform Components

All in `private/UI/Common/` (mirrored to `private/UICore/Common/`):

| Library | Purpose |
|---------|---------|
| `Microsoft.Advertising.Web.Mvc` | Core MVC: `FeatureConfigurator`, `SignupDemultiplexer`, `sharedfeatures.config` loading |
| `Microsoft.BingAds.Web` | Flighting engine: `IAllocator`, `IEvaluator`, `FlightSet`, `FlightContext` |
| `Microsoft.BingAds.Web.Authentication` | OWIN auth pipeline abstractions |
| `Microsoft.ClientCenter.Web.Security` | `AuthenticationHttpModule`, `IUserAuthenticator`, `SessionTimeoutManager` |
| `Microsoft.ClientCenter.Repository` | Data access: billing, campaign, aggregator, message center |
| `Microsoft.AdCenter.UI.Advertiser.Proxies` | WCF MT proxy classes: `CamProxy`, `ClientCenterMTProxy` |

## Feature Flighting Framework

**Config home**: `private/UI/Common/Microsoft.Advertising.Web.Mvc/Config/sharedfeatures.config`

Three sections in config:
1. `<Features>` — feature declarations (`alias`, `value`, `flip`, `pilot`, `tags`)
2. `<Flights>` / `<FlightSets>` — allocator/evaluator wiring, default allocation=0
3. `<?ap-config?>` overrides — per-environment allocation (OneBox → SI/INT → PROD → TIP)

**Allocator types**: `customerIdV2` (MurmurHash32 on customerId+seed), `muidPair` (XxHash64 on MUID+seed), `session` (JFX_SessionId cookie), `userId`

**DynamicPermissions (CampaignUI)**: Secondary flag system. Feature names in CSV in `DynamicPermissions` setting in `.cscfg`/`appsettings.json`. Uses `{Feature}Percentage` + `{Feature}PilotId` pairs.

**T4 generation**: `Features.tt` → `Features.cs` (auto-generated typed accessor). Any `sharedfeatures.config` change requires rebuild to regenerate.

**`cc-dynamic` tag**: Means the flag can be flipped client-side via query parameter.

### Higher-level flag patterns

- **`DynamicPercentagePilot` three-tier check** — runtime percentage + query-string override + static `AllowedFeature` pilot list, evaluated as a logical OR:
  ```
  IsCustomerInDynamicPercentagePilot("PerformancePredictionScorePercentage")
  || IsPilotEnabledFromQueryString("IsPerformancePredictionScoreEnabled")
  || IsCustomerinPilotForFeature(AllowedFeature.PerformancePredictionScore)
  ```
- **`AccountRedirect` with permission-method string** — `[AccountRedirect(AccountMode.UnifiedSmart, allowed:[...], "IsEscGoogleImportPostSignupFeatureOn", redirect:[...])]` resolves the string against `IPermissionProvider` via reflection.
- **`PilotEnabledFromQueryString`** — QA-time permission override via query string for any flag.
- **Notable `FeatureFlighting.config` entries**:
  - `BlobStorageResourceLoading` (60026) — 0% everywhere; placeholder for CDN bypass
  - `SharedComponentHeader` (60021) — 100% everywhere; new shared header component
  - `AdInsightRedirect` (60020) — 100% SI/PROD; redirects AdInsight domain from on-prem AP to Azure

## Auth Pipeline

Parallel login methods in `UserWorkflowHelper`:
- `LoginMsaUser` — MSA/Windows Live identity
- `LoginAadUser` — Azure AD / enterprise identity
- `LoginThirdPartyUser` / `LoginManagedUser` — Google / Facebook

OWIN Startup configures: MSA+AAD (OIDC), Google (gated by `GoogleAuthSettings.IsEnabled`), Facebook (gated by `FacebookAuthSettings.IsEnabled`), Cookie auth for sessions.

Auth security: IIS URL Rewrite rules in Edge `web.config`. `SafeAuthFallback` prevents open redirects. Max redirect count enforced (`MaxRedirects = 3`).

### Additional flows and middleware

- **`BingPlacesOAuth2Controller`** (CampaignUI) — OAuth2 + PKCE-style flow for Bing Places import. `BingPlacesCodeVerifier` loaded from KeyVault via `ISecretStore` with a hardcoded constant as fallback. `clientId` overridable via `DynamicConfigManager["BingPlacesClientId"]`. Uses custom `BingPlacesOauthProvider` with `BpPartner/Authorize` resource endpoint.
- **`UIAppScope.MultiChannelAds` redirect gate** in `RootPageController.Index()` — MCA customers are redirected to `McaPage` before the normal new-UI pilot check.
- **ESC Google Import post-signup redirect** — `[AccountRedirect]` on `RootPageController.Legacy/Index` routes `UnifiedSmart` accounts to `vnext/googleimport` or `vnext/importschedule` when `IsEscGoogleImportPostSignupFeatureOn`.
- **`SharedAuthContext` injected into `RootPageController`** — auth type (`MSA` / `AAD`) and multi-customer flag plumbed into the root controller for downstream conditional logic.
- **Copilot session data filtering** — `PrefetchODataResponse.FilterPreferences()` strips `ADS_COPILOT_SESSION_*` and `copilottestsession` preferences before serializing to client context (prevents Copilot session tokens from reaching the browser).

## Environments

| Tag | Meaning |
|-----|---------|
| SI | Staging Integration (pre-production) |
| INT | Integration test |
| BetaSI | Beta staging |
| TIP | Test In Production canary ring |
| beta-prod / PROD | Production (beta-prod = canary) |
| BCP / CUS / WUS / EUS | Business Continuity / Azure regions |

## Key Risk Signals

- Config rollout percentage changes in `sharedfeatures.config` affect feature allocation globally
- Internal user permission changes affect admin workflows
- Shared feature config changes propagate to all dependent frontends
- Helm/AKS deployment config changes affect service availability
- Dual-stack divergence: if UICore mirror doesn't match UI, one stack behaves differently
- Auth pipeline changes (OWIN, login methods) can break all user login
- `Features.cs` regeneration missed after `sharedfeatures.config` change = stale flags
- `ap-config`/`.cscfg` changes take effect on role recycle (not immediately)
- AKS `appsettings.json` changes require pod restart (Helm redeploy)
- **BingPlaces PKCE fallback** — `BingPlacesCodeVerifier` falls back to a hardcoded constant if KeyVault lookup fails, silently degrading PKCE protection
- **Copilot session leak** — `FilterPreferences()` is the only guard; null paths or swallowed exceptions can let `ADS_COPILOT_SESSION_*` tokens reach the JS context
- **Parallel OData prefetch expansion** — `FetchGoals()` and `FetchTopTwoCampaignsForOnboarding()` sit on the page-load critical path; failures are swallowed but can increase p99 latency
- **`BlobStorageResourceLoading` at 0%** — resource-loading bypass is wired but not activated; enabling requires validating CDN configs across all environments
- **`AmplifyTrackingScriptUrl`** — Azure Front Door CDN URL injected into every page context; a CDN compromise becomes a supply-chain attack surface
- **`ESCGlobalizationENMarkets` / `NonENMarkets`** — both default `false`; flipping to `true` in prod expands ESC to all markets (high blast radius)
- **`DynamicPermissions` query-string override** — `DynamicPermissionProvider.GetPermissionsMap()` reads from `Request.QueryString` with no explicit IP/internal-only guard observed in surface scan

## DRI Investigation Tips

1. **Identify the affected app**: CCUI, CMUI, SmartPage, WebUI, PMaxLiteLanding, McaUI, DmcTeams, SubscriptionAds, SupportUI?
2. **Check which stack is live**: .NET Framework (Azure Cloud Service) or .NET Core (AKS)? Remember the Framework-only apps have no UICore mirror.
3. **Feature flag state**: Check `sharedfeatures.config` `ap-config` overrides for PROD allocation. Check `.cscfg` `DynamicPermissions` CSV. For three-tier pilots, check all three layers (`DynamicPercentagePilot`, query string, `AllowedFeature`).
4. **Auth failures**: Filter Kusto by `LoginIssues::` prefix. Check `outcome=` and `idP=` fields. For BingPlaces, verify KeyVault `BingPlacesCodeVerifier` is being loaded (not the fallback).
5. **MT/WCF proxy errors**: `FaultException<SenderFaultDetail>` = MT returned new data type not in UI proxy. Check `SenderFaultDetail.ErrorList[0].Code`.
6. **Session/cookie issues**: `CookieManager` for sub-cookie parsing. `ISessionManager` for distributed cache.
7. **Config propagation delay**: `ap-config`/`.cscfg` take effect on role recycle. AKS needs pod restart.
8. **Dual-stack divergence**: If Core behaves differently from Framework, check `UICore` mirror has the same change. T4-generated `Features.cs` must be regenerated.
9. **Open redirect / auth loops**: Max redirect count enforced. `oidcc` counter tracks redirects.
10. **MCA customer routed to wrong shell**: Check `UIAppScope.MultiChannelAds` resolution in `RootPageController.Index()`.
