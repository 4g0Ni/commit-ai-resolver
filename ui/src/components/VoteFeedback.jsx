/**
 * VoteFeedback — Thumbs up/down voting for chat responses.
 */
import { useState } from 'react';

function VoteFeedback({ vote, onVote }) {
    const [showComment, setShowComment] = useState(false);
    const [comment, setComment] = useState('');

    const handleVote = (v) => {
        if (v === 'down' && vote !== 'down') {
            setShowComment(true);
        }
        onVote(v, null);
    };

    const handleSubmitComment = () => {
        onVote('down', comment);
        setShowComment(false);
    };

    return (
        <div className="vote-feedback">
            <button
                className={`vote-btn ${vote === 'up' ? 'selected' : ''} ${vote === 'down' ? 'dimmed' : ''}`}
                onClick={() => handleVote('up')}
                title="Helpful"
            >
                &#128077;
            </button>
            <button
                className={`vote-btn ${vote === 'down' ? 'selected' : ''} ${vote === 'up' ? 'dimmed' : ''}`}
                onClick={() => handleVote('down')}
                title="Not helpful"
            >
                &#128078;
            </button>
            {showComment && vote === 'down' && (
                <div className="vote-comment">
                    <input
                        type="text"
                        placeholder="What went wrong?"
                        value={comment}
                        onChange={e => setComment(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSubmitComment()}
                    />
                    <button onClick={handleSubmitComment}>Send</button>
                </div>
            )}
        </div>
    );
}

export default VoteFeedback;
