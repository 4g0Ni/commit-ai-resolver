import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { sendChatMessage, investigateCommits } from '../api';

function ChatBox() {
    const [messages, setMessages] = useState(() => {
        try {
            const saved = localStorage.getItem('chat-history');
            if (saved) return JSON.parse(saved);
        } catch {}
        return [
            {
                role: 'assistant',
                content: 'Hi! I can help you investigate changes across repositories. Try asking:\n\n• "What shipped yesterday?"\n• "Any high-risk changes this week?"\n• "What changed in AdsAppsCampaignUI recently?"\n• "We saw a latency spike starting March 28 — what might have caused it?"',
            },
        ];
    });
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef(null);
    const textareaRef = useRef(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading]);

    useEffect(() => {
        try { localStorage.setItem('chat-history', JSON.stringify(messages)); } catch {}
    }, [messages]);

    useEffect(() => {
        const el = textareaRef.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 150) + 'px';
        }
    }, [input]);

    const handleSend = async () => {
        const text = input.trim();
        if (!text || loading) return;

        const userMsg = { role: 'user', content: text };
        const updatedMessages = [...messages, userMsg];
        setMessages(updatedMessages);
        setInput('');
        setLoading(true);

        try {
            // Send conversation history (skip the initial welcome message)
            const history = updatedMessages
                .filter((_, i) => i > 0) // skip welcome
                .slice(-10); // keep last 10 messages for context

            const data = await sendChatMessage(text, history);

            if (data.type === 'clarification') {
                // System is asking for clarification — render as a special message
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: data.reply,
                    isClarification: true,
                }]);
            } else {
                // Normal answer — show metadata and suggested actions
                let reply = data.reply;
                const metaParts = [];
                if (data.iterations > 1) metaParts.push(`Search refined ${data.iterations} time(s)`);
                if (data.confidence) metaParts.push(`Confidence: ${(data.confidence * 100).toFixed(0)}%`);
                if (data.searchMethod) metaParts.push(`Method: ${data.searchMethod}`);
                if (data.resultCount) metaParts.push(`${data.resultCount} results`);

                if (metaParts.length > 0) {
                    reply += `\n\n---\n*${metaParts.join(' · ')}*`;
                }

                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: reply,
                    suggestedActions: data.suggestedActions || [],
                    suspects: data.suspects || [],
                    originalQuery: text,
                }]);
            }
        } catch (err) {
            setMessages(prev => [
                ...prev,
                { role: 'error', content: `Error: ${err.message}` },
            ]);
        } finally {
            setLoading(false);
        }
    };

    const handleInvestigate = async (msg) => {
        if (loading) return;
        setLoading(true);

        setMessages(prev => [...prev, {
            role: 'assistant',
            content: '🔍 Fetching commit diffs and analyzing code changes...',
            isInvestigating: true,
        }]);

        try {
            const history = messages
                .filter((_, i) => i > 0)
                .slice(-10);

            const data = await investigateCommits(msg.originalQuery, msg.suspects, history);

            // Replace the investigating placeholder with the real result
            setMessages(prev => {
                const updated = prev.filter(m => !m.isInvestigating);
                return [...updated, {
                    role: 'assistant',
                    content: data.reply,
                    isInvestigation: true,
                }];
            });
        } catch (err) {
            setMessages(prev => {
                const updated = prev.filter(m => !m.isInvestigating);
                return [...updated, {
                    role: 'error',
                    content: `Investigation failed: ${err.message}`,
                }];
            });
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <>
            <div className="chat-header">
                <span>Change Analysis Chat</span>
                <button
                    className="new-chat-btn"
                    onClick={() => {
                        localStorage.removeItem('chat-history');
                        setMessages([{
                            role: 'assistant',
                            content: 'Hi! I can help you investigate changes across repositories. Try asking:\n\n• "What shipped yesterday?"\n• "Any high-risk changes this week?"\n• "What changed in AdsAppsCampaignUI recently?"\n• "We saw a latency spike starting March 28 — what might have caused it?"',
                        }]);
                    }}
                    title="Start a new conversation"
                >
                    New Chat
                </button>
            </div>
            <div className="chat-messages">
                {messages.map((msg, i) => (
                    <div key={i} className={`chat-message ${msg.role}${msg.isClarification ? ' clarification' : ''}${msg.isInvestigation ? ' investigation' : ''}`}>
                        {msg.isClarification && <div className="clarification-badge">🤔 Need more details</div>}
                        {msg.role === 'user' ? msg.content : <ReactMarkdown>{msg.content}</ReactMarkdown>}
                        {msg.suggestedActions?.length > 0 && (
                            <div className="suggested-actions">
                                {msg.suggestedActions.map((action, j) => (
                                    <button
                                        key={j}
                                        className="suggested-action-chip"
                                        onClick={() => {
                                            setInput(action);
                                        }}
                                    >
                                        {action}
                                    </button>
                                ))}
                            </div>
                        )}
                        {msg.suspects?.length > 0 && !msg.isInvestigation && (
                            <div className="investigate-section">
                                <button
                                    className="investigate-btn"
                                    onClick={() => handleInvestigate(msg)}
                                    disabled={loading}
                                >
                                    Investigate these commits
                                </button>
                                <span className="investigate-hint">
                                    Fetch code diffs and analyze for root cause
                                </span>
                            </div>
                        )}
                    </div>
                ))}
                {loading && (
                    <div className="typing-indicator">
                        <span></span><span></span><span></span>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>
            <div className="chat-input-area">
                <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask about recent changes..."
                    disabled={loading}
                    rows={1}
                />
                <button onClick={handleSend} disabled={loading || !input.trim()}>
                    Send
                </button>
            </div>
        </>
    );
}

export default ChatBox;
