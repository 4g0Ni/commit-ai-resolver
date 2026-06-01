import { useState, useEffect, useRef, useCallback } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { loginRequest } from './authConfig.js';
import { fetchDays } from './api';
import Timeline from './components/Timeline';
import ChatBox from './components/ChatBox';
import FeedbackPanel from './components/FeedbackPanel';
import UsageMetrics from './components/UsageMetrics';
import ConnectMcpModal from './components/ConnectMcpModal';
import './App.css';

function LoginScreen() {
    const { instance } = useMsal();
    return (
        <div className="login-screen">
            <div className="login-card">
                <h1>Commit AI Resolver</h1>
                <p>Daily Change Tracking & Regression Analysis</p>
                <button className="login-btn" onClick={() => instance.loginRedirect(loginRequest)}>
                    Sign in with Microsoft
                </button>
            </div>
        </div>
    );
}

function App() {
    const isAuthenticated = useIsAuthenticated();
    const { instance, accounts } = useMsal();
    const account = accounts[0];
    const isAdmin = account?.username?.toLowerCase() === 'yizhang6@microsoft.com';

    const [dates, setDates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isAuthenticated) return;
        async function loadData() {
            try {
                const { dates: availableDates } = await fetchDays();
                setDates(availableDates);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        loadData();
    }, [isAuthenticated]);

    const [chatWidth, setChatWidth] = useState(() => {
        const saved = localStorage.getItem('chatPanelWidth');
        return saved ? Math.max(560, parseInt(saved, 10)) : 560;
    });
    const dragRef = useRef(null);

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = chatWidth;
        const onMove = (e) => {
            const newWidth = Math.max(360, Math.min(1200, startWidth + (startX - e.clientX)));
            setChatWidth(newWidth);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            setChatWidth(w => { localStorage.setItem('chatPanelWidth', w); return w; });
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [chatWidth]);

    const [showFeedback, setShowFeedback] = useState(false);
    const [showMetrics, setShowMetrics] = useState(false);
    const [showConnectMcp, setShowConnectMcp] = useState(false);
    const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

    if (!isAuthenticated) {
        return <LoginScreen />;
    }

    return (
        <div className="app">
            <header className="app-header">
                <h1>Commit AI Resolver</h1>
                <span className="subtitle">Daily Change Tracking & Regression Analysis</span>
                <div className="header-actions">
                    <span className="user-info" title={account?.username}>{account?.name}</span>
                    <button className="feedback-header-btn" onClick={() => setShowMetrics(true)}>
                        Metrics
                    </button>
                    {isAdmin && (
                        <button className="feedback-header-btn" onClick={() => setShowFeedback(true)}>
                            Feedback
                        </button>
                    )}
                    <button className="feedback-header-btn" onClick={() => setShowConnectMcp(true)}>
                        Connect MCP
                    </button>
                    <button className="theme-toggle-btn" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
                        {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
                    </button>
                    <button className="sign-out-btn" onClick={() => instance.logoutRedirect()}>
                        Sign out
                    </button>
                </div>
            </header>
            <div className="app-body">
                <main className="main-panel">
                    {loading && <div className="loading">Loading daily summaries...</div>}
                    {error && <div className="loading">Error: {error}</div>}
                    {!loading && !error && (
                        <Timeline
                            dates={dates}
                        />
                    )}
                </main>
                <div className="resize-handle" onMouseDown={handleMouseDown} ref={dragRef} />
                <aside className="chat-panel" style={{ width: chatWidth }}>
                    <ChatBox />
                </aside>
            </div>
            {showFeedback && isAdmin && <FeedbackPanel onClose={() => setShowFeedback(false)} />}
            {showMetrics && <UsageMetrics onClose={() => setShowMetrics(false)} />}
            {showConnectMcp && <ConnectMcpModal onClose={() => setShowConnectMcp(false)} />}
        </div>
    );
}

export default App;
