import { useState, useEffect } from 'react';
import { fetchDays, fetchDay } from './api';
import Timeline from './components/Timeline';
import ChatBox from './components/ChatBox';
import './App.css';

function App() {
    const [dates, setDates] = useState([]);
    const [dayData, setDayData] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        async function loadData() {
            try {
                const { dates: availableDates } = await fetchDays();
                setDates(availableDates);

                // Load all days in parallel
                const results = await Promise.all(
                    availableDates.map(d => fetchDay(d).catch(() => null))
                );

                const dataMap = {};
                results.forEach((data, i) => {
                    if (data) dataMap[availableDates[i]] = data;
                });
                setDayData(dataMap);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        loadData();
    }, []);

    return (
        <div className="app">
            <header className="app-header">
                <h1>Commit AI Resolver</h1>
                <span className="subtitle">Daily Change Tracking & Regression Analysis</span>
            </header>
            <div className="app-body">
                <main className="main-panel">
                    {loading && <div className="loading">Loading daily summaries...</div>}
                    {error && <div className="loading">Error: {error}</div>}
                    {!loading && !error && (
                        <Timeline
                            dates={dates}
                            dayData={dayData}
                        />
                    )}
                </main>
                <aside className="chat-panel">
                    <ChatBox />
                </aside>
            </div>
        </div>
    );
}

export default App;
