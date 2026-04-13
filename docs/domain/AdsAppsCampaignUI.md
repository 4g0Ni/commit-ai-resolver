# AdsAppsCampaignUI — Domain Knowledge

## Repository Overview

AdsAppsCampaignUI is a monorepo containing the Microsoft Advertising web frontend. It houses two separate SPAs:
- **CMUI (Campaign Management UI)** at `ui.ads.microsoft.com` — campaign CRUD, bidding, keyword management
- **CCUI (Client Center UI)** at `ads.microsoft.com` — account management, billing, user settings

Navigating between them triggers a full-page refresh. Long-term goal is to merge CCUI pages into CMUI.

## Business Terms

- **CMUI (Campaign Management UI)**: Main SPA for campaign management in `private/ui-next/`
- **CCUI (Client Center UI)**: Account/billing portal in `private/clientcenter/`
- **BAE (Bing Ads Experience)**: Shared component library in `private/adsappsbae/`
- **BAM (Bulk Ads Manager)**: Bulk upload/download in `private/bam/`
- **MCA (Multi-Channel Ads)**: Cross-platform ads (Facebook, LinkedIn, Twitter) in `private/multi-channel/`
- **OMS (Order Management System)**: Media plan/line-item management in `private/oms/`
- **UCM (Unified Campaign Management)**: Campaign page bundles in `private/ucm-web/`
- **UFL (Unified Feature Library)**: DynamicPermissions system for feature flags
- **PMax (Performance Max)**: Automated campaign type with goal-based optimization across Search, Shopping, Display, App, Xbox
- **PMax Lite**: Simplified PMax signup/onboarding flow
- **UET (Universal Event Tracking)**: Conversion goal tracking tags on advertiser websites
- **ROAS (Return On Ad Spend)**: Key advertiser performance metric — revenue per dollar spent
- **MMC (Microsoft Merchant Center)**: Product feed management for Shopping campaigns
- **GMC (Google Merchant Center)**: Google equivalent; import/mapping features for migration
- **DSA (Dynamic Search Ads)**: Auto-generated ads from website content
- **RSA (Responsive Search Ads)**: Ad type with rotating headlines/descriptions
- **SSC (Smart Shopping Campaign)**: Automated shopping campaign type
- **CTV (Connected TV)**: Premium Streaming Ads
- **IBRMT (Impression-Based Remarketing)**: Remarketing by impression exposure
- **MCC (My Client Center)**: Agency managing multiple advertiser accounts
- **DSP (Demand-Side Platform)**: Programmatic ad buying
- **DMC (Digital Marketing Center)**: Simplified marketing tools
- **FAC (Feature-Action Coupons)**: Recommendation display config
- **Copilot**: AI-powered campaign creation assistant (MSA Copilot, Ads Copilot Chat UI)
- **DRI (Deployment Response Incident)**: On-call engineer role

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/ui-next/` | CMUI main SPA — campaign management |
| `private/clientcenter/` | CCUI — billing, account management |
| `private/clientcenter-shared/` | Shared CCUI infrastructure |
| `private/adsappsbae/` | BAE — shared component library |
| `private/advisor/` | Advisor / Recommendations engine |
| `private/bam/` | BAM — bulk upload/download |
| `private/multi-channel/` | MCA — Facebook, LinkedIn, Twitter ads |
| `private/oms/` | OMS — media plan / line-item management |
| `private/smart-campaigns/` | Smart Campaigns — simplified flow for SMBs |
| `private/smart-page/` | Smart Page — smart campaign landing page |
| `private/perf-max-campaign/` | PMax campaign creation flows |
| `private/pmax-lite-signup/` | PMax Lite simplified signup |
| `private/audience-campaign/` | Audience Campaigns (display/native) |
| `private/audience-dashboard/` | Audience Dashboard |
| `private/shopping-campaign/` | Shopping Campaigns |
| `private/linkedin-campaign/` | LinkedIn Campaign |
| `private/search-campaign/` | Search Campaign creation |
| `private/reporting-ui/` | Reporting UI |
| `private/conversion-tracking/` | Conversion Tracking / UET |
| `private/hotel-center/` | Hotel Center |
| `private/keyword-planner/` | Keyword Planner |
| `private/ucm-web/` | UCM — campaign page bundles |
| `private/bam-ucm/` | BAM for UCM |
| `private/change-history/` | Change History |
| `private/campaign-legacy/` | Legacy Campaign modules |
| `private/component-react-fluent-v2/` | Fluent V2 shared components |
| `private/component-react-fluent/` | Fluent V1 shared components |
| `private/shared-client/` | Shared client infra (grid, filters, etc.) |
| `private/cloud-test/` | E2E test infrastructure |
| `private/loc/` | Localization string files |

## Environments

- **SI (Staging Integration)**: Pre-production environment
- **INT**: Integration test environment
- **beta-prod / PROD**: Production (beta-prod = canary ring before full PROD rollout)

## Feature Flag Architecture

Three distinct permission systems unified by `getPilotValue()`:

### 1. Traditional Server Permissions
```
serverContext.Permissions.Is<FlagName>Enabled
```
PascalCase, checked in recommendation type gating:
```js
case RECOMMENDATION_TYPES.BUDGET:
  return permissions.IsRecommendationTypeBudgetEnabled;
```

### 2. Dynamic / UFL Permissions
```
serverContext.DynamicPermissions.<FlagName>
```
Newer pattern, requires both static + dynamic permission:
```js
return permissions.IsCampaignUINAQEnabled && permissions.dynamic && permissions.dynamic.NAQRecommendation;
```

### 3. GA Allowlist (`GA_NO_PILOTING_TYPES`)
Types in this array bypass all permission checks — always shown to all users. Disabling = commenting out from array.

### 4. URL Parameter Override
Any recommendation type force-enabled via query param:
```
?IsRecommendationType{TypeName}Enabled=true
```

### 5. Legacy Numeric Pilot IDs
`pilot-map.js` maps numeric IDs (e.g., `CPA: 16`, `CPM: 5`) for test/WCF infrastructure.

## Additional Flag Patterns

- `Permissions.*` prefix — Feature gates at account/user level
- `CampaignFlights.*` prefix — Account-level flight gates
- `_treatment` / `_control` suffixes — A/B test arms
- `Enable*` prefix — Feature enablement flags
- `is*Enabled` pattern — Boolean feature checks
- Pilot ramp percentages: 10% = limited, 50% = broad, 100% = fully shipped

## Key Risk Signals

- Changes to shared grid components (FluentGrid, grid-addons) affect all campaign pages
- PMax wizard step changes can break campaign creation flow
- Conversion tracking changes affect advertiser measurement
- Budget/bidding cell rendering changes affect all campaign grid views
- Feature flag removals = shipping to 100% of users
- Shared component library (BAE) changes cascade to all consuming SPAs
- CCUI/CMUI SPA boundary: changes must consider which SPA they affect
- Recommendation gating changes via `GA_NO_PILOTING_TYPES` array have immediate global effect
