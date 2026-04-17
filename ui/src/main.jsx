import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MsalProvider } from '@azure/msal-react';
import { msalInstance } from './authConfig.js';
import './index.css';
import App from './App.jsx';

msalInstance.initialize().then(() => {
    msalInstance.handleRedirectPromise().then(() => {
        createRoot(document.getElementById('root')).render(
            <StrictMode>
                <MsalProvider instance={msalInstance}>
                    <App />
                </MsalProvider>
            </StrictMode>,
        );
    });
});
