import { useState } from 'react';

const MCP_URL = window.location.origin + '/mcp';
const INSTALL_URL = window.location.origin + '/install/setup-commit-resolver.ps1';
const RUN_COMMAND = 'powershell -ExecutionPolicy Bypass -File .\\setup-commit-resolver.ps1';

function ConnectMcpModal({ onClose }) {
    const [copied, setCopied] = useState(null);

    const copy = async (text, key) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(key);
            setTimeout(() => setCopied(c => (c === key ? null : c)), 2000);
        } catch (err) {
            console.error('Clipboard copy failed:', err);
        }
    };

    return (
        <div className="feedback-overlay" onClick={onClose}>
            <div className="feedback-panel connect-mcp-panel" onClick={e => e.stopPropagation()}>
                <div className="feedback-panel-header">
                    <h2>Connect MCP Client</h2>
                    <button className="feedback-close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="connect-mcp-body">
                    <p className="connect-mcp-intro">
                        One installer wires this MCP server into Claude Desktop, Claude Code, and VS Code,
                        and drops the <code>commit-resolver</code> skill into <code>~/.claude/skills</code>.
                    </p>

                    <ol className="connect-mcp-steps">
                        <li>
                            <div className="connect-mcp-step-title">Download the installer</div>
                            <div className="connect-mcp-step-body">
                                <a className="connect-mcp-download" href={INSTALL_URL} download>
                                    Download setup-commit-resolver.ps1
                                </a>
                                <div className="connect-mcp-hint">
                                    Defaults to MCP URL <code>{MCP_URL}</code> — no flags needed.
                                </div>
                            </div>
                        </li>

                        <li>
                            <div className="connect-mcp-step-title">Run it in PowerShell</div>
                            <div className="connect-mcp-step-body">
                                <div className="connect-mcp-code">
                                    <code>{RUN_COMMAND}</code>
                                    <button
                                        className="connect-mcp-copy"
                                        onClick={() => copy(RUN_COMMAND, 'run')}
                                    >
                                        {copied === 'run' ? 'Copied!' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                        </li>

                        <li>
                            <div className="connect-mcp-step-title">Restart your MCP client</div>
                            <div className="connect-mcp-step-body">
                                Quit and reopen Claude Desktop, Claude Code, or VS Code so it picks up the
                                new server config.
                            </div>
                        </li>

                        <li>
                            <div className="connect-mcp-step-title">Sign in on first use</div>
                            <div className="connect-mcp-step-body">
                                Invoke the skill (e.g. ask <em>"what changed in CMUI yesterday?"</em>).
                                A browser tab pops up for Microsoft sign-in the first time. Tokens are
                                cached after that.
                            </div>
                        </li>
                    </ol>

                    <p className="connect-mcp-footer">
                        To uninstall later: <code>.\setup-commit-resolver.ps1 -Uninstall</code>
                    </p>
                </div>
            </div>
        </div>
    );
}

export default ConnectMcpModal;
