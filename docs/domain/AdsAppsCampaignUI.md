# AdsAppsCampaignUI — Domain Knowledge

## Repository Overview

AdsAppsCampaignUI is a monorepo containing the Microsoft Advertising web frontend. It houses two separate SPAs:
- **CMUI (Campaign Management UI)** at `ui.ads.microsoft.com` — campaign CRUD, bidding, keyword management
- **CCUI (Client Center UI)** at `ads.microsoft.com` — account management, billing, user settings

Navigating between them triggers a full-page refresh. Long-term goal is to merge CCUI pages into CMUI.

## Business Terms

- **CMUI (Campaign Management UI)**: Main SPA for campaign management in `private/ui-next/`
- **CCUI (Client Center UI)**: Account/billing portal in `private/clientcenter/`
- **BAE (Bing Ads Experience)**: Shared component library in `private/adsappsbae/`. Now includes a GraphQL layer (`graphql`, `graphql-entities`) alongside the existing OData stack — two concurrent data models can co-exist for the same entities.
- **BAM (Bulk Ads Manager)**: Bulk upload/download in `private/bam/`
- **MCA (Multi-Channel Ads)**: Cross-platform ads (Facebook, LinkedIn, Twitter) in `private/multi-channel/`
- **OMS (Order Management System)**: Programmatic/IO-based media buying as a standalone SPA in `private/oms/`. Route base `/campaign/oms`, separate build entry (`oms-bundle`).
- **UCM (Unified Campaign Management)**: Campaign page bundles in `private/ucm-web/`
- **UFL (Unified Feature Library)**: DynamicPermissions system for feature flags
- **PMax (Performance Max)**: Automated campaign type with goal-based optimization across Search, Shopping, Display, App, Xbox
- **PMax Lite**: Simplified PMax signup/onboarding flow in `private/pmax-lite-signup/` (~40 packages). Includes **Agentic** sub-packages (`pmax-agentic-business-info`, `pmax-agentic-campaign-draft`, `pmax-agentic-snapshot-review`) where the user uploads brand materials and AI drafts the campaign.
- **Ads Studio**: Creative/asset management SPA in `private/ads-studio/`. Gated by `dynamic.AdsStudioMVP`; replaces Asset Library nav entry when on.
- **MS Ads SDK**: Embeddable widget SDK in `private/ms-ads-sdk/` for first/third-party embedding of signup, campaign creation, and ad-preview flows. Scenarios: `signup`, `campaign`, `campaigncreation`, `adpreviewbanner`, `sdkpmaxlp`, `signinwithexistingaccount`. Own `sdk-bundle`, `sdk-bootstrap`, `sdk-wizard-components` packages.
- **Xandr**: Microsoft Advertising Network (formerly AppNexus/Xandr). Video, display, and standard campaign flows in `ui-next` (`xandr-video-campaign`, `xandr-display-ads-campaign`, `xandr-campaign`). Billing/account integration in CCUI (`xandr-account-settings`, `xandr-baf`, `xandr-bank-association`, `xandr-customer-onboarding`).
- **AIM Campaign**: Audience Intelligence Machine campaign type (Xandr video + genre targets)
- **BAF**: Business Account Funding — Xandr billing association
- **Display+**: Display Plus campaign type
- **Genre Targets**: Xandr/AIM genre-based targeting
- **UET (Universal Event Tracking)**: Conversion goal tracking tags on advertiser websites
- **ROAS (Return On Ad Spend)**: Key advertiser performance metric — revenue per dollar spent
- **CPC / CPV / CPM / CPS**: Cost Per Click / View / Mille (thousand impressions) / Sale. CPS is a newer PMax reporting metric (`SupportCPSForPmax`).
- **MMC (Microsoft Merchant Center)**: Product feed management for Shopping campaigns
- **GMC (Google Merchant Center)**: Google equivalent; import/mapping for migration
- **DSA (Dynamic Search Ads)**: Auto-generated ads from website content
- **RSA (Responsive Search Ads)**: Ad type with rotating headlines/descriptions
- **SSC (Smart Shopping Campaign)**: Automated shopping campaign type
- **CTV (Connected TV)**: Premium Streaming Ads
- **IBRMT (Impression-Based Remarketing)**: Remarketing by impression exposure
- **MCC (My Client Center)**: Agency managing multiple advertiser accounts
- **DSP (Demand-Side Platform)**: Programmatic ad buying
- **DMC (Digital Marketing Center)**: Simplified marketing tools
- **FAC (Feature-Action Coupons)**: Recommendation display config
- **Copilot**: AI-powered campaign creation assistant. Surface area in `private/ads-copilot/` now includes Live Agent (`copilot-live-agent`), troubleshooting (`copilot-troubleshooting`, `copilot-troubleshooting-state-machine`), persistent chat history (`copilot-chat-history`, `copilot-chat-history-data`), context awareness (`copilot-customer-context-awareness`), rich rendering (`copilot-enriched-table`, `copilot-chart-renderer`), and additional entry points (`global-search-copilot`, `msa-copilot`). BAE integrates Copilot via `inline-copilot`, `notification-bell`, `notification-banner`.
- **DRI (Deployment Response Incident)**: On-call engineer role
- **UCP (Universal Checkout Program)**: Merchant native-checkout integration — merchants expose `/.well-known/ucp` endpoint for seamless checkout
- **OCV (Office Customer Voice)**: Microsoft's in-app feedback framework (`@ms/centro-hvc-loader`), powers thumbs-up/down feedback in Ads Copilot chat
- **Amplify / MSAN Boost**: Extending Search campaigns to Microsoft Audience Network for additional audience reach
- **MSAN**: Microsoft Audience Network. `PmaxMSANContentExclusions` pilot gates content exclusion UI.
- **MMA (Multimedia Ads)**: Responsive ad format combining headlines, descriptions, and images for search/audience placements
- **EDM (Entity Data Model)**: OData schema/type layer for client-side data stack (overreact, js-data) — foundational infrastructure all data-fetching packages depend on
- **UHF (Universal Header & Footer)**: Microsoft's standard site-wide header/nav/footer for public-facing marketing pages
- **SSG (Static Site Generation)**: Build-time HTML generation pipeline for the `ads.microsoft.com` marketing landing page in `private/mkt-landing/` (`mkt-landing-ssg-template`, 38 locales, ~5KB vanilla JS). Different build/deploy profile from the SPA packages.
- **Experiments V2**: Redesigned campaign experimentation framework supporting Uplift, Upgrade, Optimization, and Incrementality experiment types. Pages live in `ui-next` (`experiments-v2-page`, `experiments-v2-results-page`, `experiments-v2-edit-page`); shared utilities in `component-react-fluent-v2/experiments-v2-shared`.
- **Company Name List (CNL)**: Audience targeting by company name lists. Pages in `ui-next` (`company-name-list-page`, `company-name-list-details-page`); shared components in `component-react-fluent-v2` (`company-name-list-form`, `company-name-list-delete`, `company-name-list-selector`).
- **Website Exclusion Lists**: Account/customer-level website exclusion management — `website-exclusion-lists-page`, `website-exclusion-lists-account-level-list-page`, `website-exclusion-lists-account-level-exclusions-page`, `website-exclusion-lists-customer-edit-page`.
- **HotelCenterV2**: Next-gen hotel ads UI in `hotel-center-v2-page`. Legacy HotelCenter is being phased out via paired deprecation/removal flags.
- **TIP**: Third-party integration partner (`isTIP` in MS Ads SDK)
- **Asset Performance Prediction**: AI/ML component predicting individual ad asset performance (Low/Medium/High) in RSA and display ads
- **Google Import**: Full-featured Google Ads campaign importer (OAuth, one-time or scheduled, smart import). In BAE this is now exposed as a service (`google-import`, `google-import-*`).
- **Combined Conversion Wizard**: Unified multi-step wizard combining UET base tag setup with conversion goal creation
- **TAPI (Test API)**: End-to-end test infrastructure for Selenium-based automated testing
- **`@aiContributed-MAPFuse-<DATE>`**: Annotation marking files modified by AI agents (e.g., in `permissions.ts`) — useful signal in diffs.

## Folder-to-Domain Mapping

| Folder | Domain |
|--------|--------|
| `private/ui-next/` | CMUI main SPA — campaign management |
| `private/clientcenter/` | CCUI — billing, account management |
| `private/clientcenter-shared/` | Shared CCUI infrastructure |
| `private/adsappsbae/` | BAE — shared component library (now also hosts GraphQL data layer, Copilot integration surfaces, Google Import as Service, media editor, undo-redo, exposure control, dialog/popup infrastructure) |
| `private/advisor/` | Advisor / Recommendations engine |
| `private/bam/` | BAM — bulk upload/download |
| `private/multi-channel/` | MCA — Facebook, LinkedIn, Twitter ads |
| `private/oms/` | OMS — standalone media plan / line-item SPA |
| `private/smart-campaigns/` | Smart Campaigns — simplified flow for SMBs |
| `private/smart-page/` | Smart Page — smart campaign landing page |
| `private/perf-max-campaign/` | PMax campaign creation flows |
| `private/pmax-lite-signup/` | PMax Lite simplified signup (includes Agentic AI sub-packages) |
| `private/ads-studio/` | Ads Studio — creative / asset management SPA |
| `private/ms-ads-sdk/` | Embeddable SDK for third-party embedding |
| `private/audience-campaign/` | Audience Campaigns (display/native) |
| `private/audience-dashboard/` | Audience Dashboard |
| `private/shopping-campaign/` | Shopping Campaigns |
| `private/linkedin-campaign/` | LinkedIn Campaign |
| `private/search-campaign/` | Search Campaign creation |
| `private/reporting-ui/` | Reporting UI — dedicated monorepo (`report-create`, `report-schema`, `report-charts`, `reporting-tapi`) |
| `private/conversion-tracking/` | Conversion Tracking / UET |
| `private/hotel-center/` | Hotel Center (legacy; being deprecated in favor of `hotel-center-v2-page` in ui-next) |
| `private/keyword-planner/` | Keyword Planner |
| `private/ucm-web/` | UCM — campaign page bundles |
| `private/bam-ucm/` | BAM for UCM |
| `private/change-history/` | Change History |
| `private/campaign-legacy/` | Legacy Campaign modules |
| `private/component-react-fluent-v2/` | Fluent V2 shared components (includes chart infra, grid-shared, tag-selector, unified-diagnostic-card, Experiments V2 / CNL components) |
| `private/component-react-fluent/` | Fluent V1 shared components |
| `private/shared-client/` | Shared client infra (grid, filters, etc.) |
| `private/shared-client-data/` | EDM core, OData data layer infrastructure |
| `private/cloud-test/` | E2E test infrastructure |
| `private/loc/` | Localization string files |
| `private/merchant-store-settings/` | Merchant Center UCP settings and store configuration |
| `private/merchant-center-store-overview/` | Merchant Center store overview page and UCP diagnostics |
| `private/ads-copilot/` | Ads Copilot chat UI, OCV feedback, Live Agent, troubleshooting, chat history, context awareness, rich rendering |
| `private/mkt-landing/` | Marketing landing page SSG template (UHF, 38 locales) |
| `private/experiments-v2-*/` | Experiments V2 — create, edit, results pages |
| `private/client-import/` | Google/platform import packages |
| `private/survey/` | Survey exporting tools (OCV responses) |

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

### 6. CCUI Pilot Namespace
`CCUIPilots.dynamic.<Flag>` — separate pilot namespace in clientcenter, distinct from the main DynamicPermissions. Examples: `NavigationRefreshSignup`, `TSTSignUpInformationSupplement`, `TSTUserInvitation`, `PidlTemplates`, `VertexOnboardingLightbox`.

## Additional Flag Patterns

- `Permissions.*` prefix — Feature gates at account/user level
- `CampaignFlights.*` prefix — Account-level flight gates
- `_treatment` / `_control` suffixes — A/B test arms
- `Enable*` prefix — Feature enablement flags
- `is*Enabled` pattern — Boolean feature checks
- **Phased rollout with split flags** — single features often gated by multiple co-existing flags. Examples: `NavigationRefresh{,New,Tools,ToolsCSATSurvey,ToolsRecent}`; Xandr's hierarchical gating (`XandrIntegrationEnabled` enables the platform, then sub-types `XandrVideoCampaigns` / `XandrDisplayAdsCampaigns` layer on top).
- **Deprecation + removal gate pair** — `HotelCenterDeprecation` + `HotelCenterRemoval` co-exist alongside `HotelAds`, `HotelCenterV2`, `IsRenameHotelToLodgingEnabled` for a five-flag deprecation path.

## Key Risk Signals

- Changes to shared grid components (FluentGrid, grid-addons) affect all campaign pages
- Fluent V2 grid migrations in `ui-next` (`fluent-ads-page`, `fluent-campaign-settings-page`, `fluent-search-terms-page`, `fluent-negative-keywords-page`, `fluent-keywords-page`, `fluent-goals-page`, `fluent-audiences-page`, `fluent-tags-page`) — risk of behavioral drift from legacy grids during transition
- PMax wizard step changes can break campaign creation flow
- **Agentic AI campaign creation** (`pmax-agentic-*`) — non-deterministic AI output in a financial product; verify server-side guardrails
- **MS Ads SDK external embedding** — cross-origin event messaging (`SDKEventTypes`); coupon/payment flows exposed to external callers (`isSDKCouponEnabled`, `isSDKPhase2Enabled`); new attack surface
- **Xandr integration sprawl** — multi-package surface across CMUI/CCUI; `XandrBaf` / `xandr-bank-association` touch billing flows; watch for schema drift between Xandr and Bing Ads entity models
- **OMS standalone SPA** — separate build pipeline, different route base (`/campaign/oms`), direct media-plan/line-item mutations unrelated to the standard campaign entity model
- **HotelCenter deprecation sequence** — five overlapping gating flags create complex conditional logic; high regression risk during cleanup
- **Navigation Refresh phased rollout** — overlapping `NavigationRefresh*` flags branch side-nav/breadcrumb logic in many files; fragile during merges
- **GraphQL in BAE** — new data layer alongside existing OData; two concurrent data models for the same entities can drift
- Conversion tracking changes affect advertiser measurement
- Budget/bidding cell rendering changes affect all campaign grid views
- Feature flag removals = shipping to 100% of users
- Shared component library (BAE) changes cascade to all consuming SPAs
- CCUI/CMUI SPA boundary: changes must consider which SPA they affect
- Recommendation gating changes via `GA_NO_PILOTING_TYPES` array have immediate global effect
- EDM schema changes affect all data-fetching packages across the app
