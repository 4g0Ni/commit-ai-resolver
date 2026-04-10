import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { sendChatMessage } from '../api';

function ChatBox() {
    const [messages, setMessages] = useState([
        {
            role: 'assistant',
            content: 'Hi! I can help you investigate changes across repositories. Try asking:\n\n• "What shipped yesterday?"\n• "Any high-risk changes this week?"\n• "What changed in AdsAppsCampaignUI recently?"\n• "We saw a latency spike starting March 28 — what might have caused it?"',
        },
    ]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const messagesEndRef = useRef(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, loading]);

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
                // Normal answer — optionally show metadata
                let reply = data.reply;
                if (data.iterations > 1) {
                    reply += `\n\n<small>🔍 *Search refined ${data.iterations} time(s)${data.confidence ? ` · Confidence: ${(data.confidence * 100).toFixed(0)}%` : ''}*</small>`;
                }
                setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
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

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <>
            <div className="chat-header">Change Analysis Chat</div>
            <div className="chat-messages">
                {messages.map((msg, i) => (
                    <div key={i} className={`chat-message ${msg.role}${msg.isClarification ? ' clarification' : ''}`}>
                        {msg.isClarification && <div className="clarification-badge">🤔 Need more details</div>}
                        {msg.role === 'user' ? msg.content : <ReactMarkdown>{msg.content}</ReactMarkdown>}
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
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask about recent changes..."
                    disabled={loading}
                    rows={1}
                    onInput={e => {
                        e.target.style.height = 'auto';
                        e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
                    }}
                />
                <button onClick={handleSend} disabled={loading || !input.trim()}>
                    Send
                </button>
            </div>
        </>
    );
}

export default ChatBox;
