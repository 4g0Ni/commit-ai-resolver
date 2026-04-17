import { PublicClientApplication } from '@azure/msal-browser';

export const msalConfig = {
    auth: {
        clientId: 'bc4d2d3c-b205-42f4-90f6-8bac756fd7f5',
        authority: 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47',
        redirectUri: window.location.origin,
    },
    cache: {
        cacheLocation: 'localStorage',
        storeAuthStateInCookie: true,
    },
};

export const loginRequest = {
    scopes: ['User.Read'],
};

export const msalInstance = new PublicClientApplication(msalConfig);
