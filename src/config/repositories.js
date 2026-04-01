/**
 * Repository configuration for tracked Azure DevOps repositories.
 * Add new repositories here to include them in daily change tracking.
 */

const ADO_ORG = 'msasg';
const ADO_PROJECT = 'Bing_Ads';

const REPOSITORIES = {
    AdsAppsCampaignUI: {
        name: 'AdsAppsCampaignUI',
        project: ADO_PROJECT,
        defaultBranch: 'refs/heads/master',
    },
    AdsAppsMT: {
        name: 'AdsAppsMT',
        project: ADO_PROJECT,
        defaultBranch: 'refs/heads/master',
    },
};

export { ADO_ORG, ADO_PROJECT, REPOSITORIES };
