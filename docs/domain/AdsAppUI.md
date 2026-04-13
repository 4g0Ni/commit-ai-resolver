# AdsAppUI — Domain Knowledge

## Repository Overview

AdsAppUI is the shared UI platform and infrastructure layer for Microsoft Advertising. It runs a **dual-stack architecture**: `private/UI/` (ASP.NET Framework / net472) and `private/UICore/` (ASP.NET Core / .NET 10+). Any business logic change must be mirrored to both stacks.

## Business Terms

- **CCUI (Client Center UI)**: Account/billing portal in `private/UI/ClientCenter/Root/`
- **CMUI / CAP (Campaign Management UI)**: Campaign management in `private/UI/CampaignUI/`
- **MT (Middle Tier)**: Backend WCF services (CampaignManagement.MiddleTier, ClientCenter MT)
- **CCMT (ClientCenter Middle Tier)**: Proxy namespace `Microsoft.Advertiser.ClientCenter.MT.Proxy`
- **OMS (Order Management System)**: Flight/feature flag alias in `sharedfeatures.config`
- **PMax (Performance Max)**: Automated campaign type
- **PMax Lite**: Simplified PMax signup/onboarding in `private/UI/PMaxLiteLanding/`
- **ESC (Expert Signup Center)**: SmartPage expert-level signup flow
- **UP (Unified Product)**: Unified signup flow
- **DMC (Direct Mail Campaign)**: Signup flow variant
- **SAP**: Third-party billing system integration in MonthlyInvoice/PAAS flows
- **PAAS (Partner As Advertiser System)**: Google/Meta/Facebook partner advertiser flows
- **ABL (Advertising Billing & Localization)**: Tax and billing localization
- **DSP (Demand-Side Platform)**: Programmatic ad buying UI in `private/UI/DspUI/`
- **MCA**: Microsoft Advertising Academy/marketplace UI
- **MUID (Microsoft User ID)**: Anonymous cookie for flighting bucket allocation
- **MAP (Microsoft Advertising Platform)**: Broader platform name
- **AIV (Ad Intelligence Verification)**: Pre-submission validation checks for ads
- **DRI (Directly Responsible Individual)**: On-call engineer

## Dual-Stack Architecture

| Stack | Path | Framework | Deployment |
|-------|------|-----------|------------|
| Legacy | `private/UI/` | ASP.NET Framework (net472) | Azure Cloud Service (`.cscfg`/`.csdef`) |
| Core | `private/UICore/` | ASP.NET Core (.NET 10) | AKS via Helm (`helm-netcore`) |

**Mirror rule**: Every change in `private/UI/...` with shared business logic **must** be applied identically to `private/UICore/...`. Differences are limited to HTTP context APIs:
- Legacy: `HttpContextBase`, `System.Web`, `httpContext.Request.Cookies["x"].Value`
- Core: `HttpContext`, `Microsoft.AspNetCore.Http`, `httpContext.Request.Cookies["x"]` (returns string directly)

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/UI/WebUI/` | Login / Root Page — entry point, `RootPageController` |
| `private/UI/ClientCenter/Root/` | ClientCenter (CCUI) — account management, billing, invitations |
| `private/UI/ClientCenter/Support/` | SupportUI — internal Microsoft support tooling |
| `private/UI/CampaignUI/` | Campaign Management (CMUI) — ad campaign CRUD, reporting |
| `private/UI/SmartPage/` | SmartPage Signup — ESC, UP, DMC signup flows |
| `private/UI/PMaxLiteLanding/` | Performance Max Lite — simplified onboarding |
| `private/UI/ReportingUI/` | Reporting — AdCenter reporting grid, metrics |
| `private/UI/DspUI/` | DSP UI — Demand-Side Platform |
| `private/UI/McaUI/` | MCA UI — Microsoft Advertising Academy |
| `private/UI/SubscriptionAds/` | Subscription Ads products |
| `private/UI/Common/` | Shared platform libs (see Platform Components) |
| `private/UI/Platform/` | Framework controls, library |
| `private/UI/Assets/clientcenter/` | ClientCenter SPA (React) webpack bundles |
| `private/UI/Assets/campaignui/` | CampaignUI SPA webpack bundles |
| `private/UI/Localization/` | strings.resx for all i18n |
| `private/UICore/*/` | .NET Core mirrors of all above apps |
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

## Auth Pipeline

Three parallel login methods in `UserWorkflowHelper`:
- `LoginMsaUser` — MSA/Windows Live identity
- `LoginAadUser` — Azure AD / enterprise identity
- `LoginThirdPartyUser` / `LoginManagedUser` — Google / Facebook

OWIN Startup configures: MSA+AAD (OIDC), Google (gated by `GoogleAuthSettings.IsEnabled`), Facebook (gated by `FacebookAuthSettings.IsEnabled`), Cookie auth for sessions.

Auth security: IIS URL Rewrite rules in Edge `web.config`. `SafeAuthFallback` prevents open redirects. Max redirect count enforced (`MaxRedirects = 3`).

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

## DRI Investigation Tips

1. **Identify the affected app**: CCUI, CMUI, SmartPage, WebUI, PMaxLiteLanding, SupportUI?
2. **Check which stack is live**: .NET Framework (Azure Cloud Service) or .NET Core (AKS)?
3. **Feature flag state**: Check `sharedfeatures.config` `ap-config` overrides for PROD allocation. Check `.cscfg` `DynamicPermissions` CSV.
4. **Auth failures**: Filter Kusto by `LoginIssues::` prefix. Check `outcome=` and `idP=` fields.
5. **MT/WCF proxy errors**: `FaultException<SenderFaultDetail>` = MT returned new data type not in UI proxy. Check `SenderFaultDetail.ErrorList[0].Code`.
6. **Session/cookie issues**: `CookieManager` for sub-cookie parsing. `ISessionManager` for distributed cache.
7. **Config propagation delay**: `ap-config`/`.cscfg` take effect on role recycle. AKS needs pod restart.
8. **Dual-stack divergence**: If Core behaves differently from Framework, check `UICore` mirror has same change. T4-generated `Features.cs` must be regenerated.
9. **Open redirect / auth loops**: Max redirect count enforced. `oidcc` counter tracks redirects.
