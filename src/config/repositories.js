/**
 * Repository configuration for tracked Azure DevOps repositories.
 * Add new repositories here to include them in daily change tracking.
 */

const ADO_ORG = 'msasg';
const ADO_PROJECT = 'Bing_Ads';

/** Pipeline definition ID for the release pipeline ("MAP WebUI Daily Shipping"). */
const RELEASE_PIPELINE_DEFINITION_ID = 66277;

/** Log task name patterns in the release build that contain source commit info. */
const RELEASE_LOG_TASKS = {
    AdsAppsCampaignUI: 'Log AdsAppsCampaignUI',
    AdsAppUI:          'Log AdsAppUI_Release_WebUI',
};

/**
 * Tag strategy types:
 *   'dateSorted' — Tags like "Prefix.YYYYMMDD.NN". Sorted by date+sequence desc.
 *   'rolling'    — Named deployment tags (e.g. MT_STAGING, MT_LKG). Compare two named tags.
 *   'versioned'  — Tags like "sha-versioned.329". Sorted by version number.
 */

const REPOSITORIES = {
    AdsAppsCampaignUI: {
        name: 'AdsAppsCampaignUI',
        project: ADO_PROJECT,
        defaultBranch: 'refs/heads/master',
        tagStrategy: 'dateSorted',
        tagPattern: 'tags/UnifiedUIDoubleRepoLKG.',
    },
    AdsAppsMT: {
        name: 'AdsAppsMT',
        project: ADO_PROJECT,
        defaultBranch: 'refs/heads/master',
        tagStrategy: 'rolling',
        tagPattern: 'tags/MT_',
        // Compare commits between STAGING (newest deploy) and LKG (last known good)
        releaseTags: { current: 'MT_STAGING', previous: 'MT_LKG' },
    },
    // AdsAppsDB: {
    //     name: 'AdsAppsDB',
    //     project: ADO_PROJECT,
    //     defaultBranch: 'refs/heads/master',
    //     tagStrategy: 'versioned',
    //     tagPattern: 'tags/',
    // },
    // AnB: {
    //     name: 'AnB',
    //     project: ADO_PROJECT,
    //     defaultBranch: 'refs/heads/master',
    //     tagStrategy: 'versioned',
    //     tagPattern: 'tags/',
    // },
    // AdsAppUI: {
    //     name: 'AdsAppUI',
    //     project: ADO_PROJECT,
    //     defaultBranch: 'refs/heads/master',
    //     tagStrategy: 'versioned',
    //     tagPattern: 'tags/',
    // },
};

export { ADO_ORG, ADO_PROJECT, REPOSITORIES, RELEASE_PIPELINE_DEFINITION_ID, RELEASE_LOG_TASKS };
