"""
MCP Server for parsing and applying git diffs
Handles the specific diff format that Claude generates
"""

import asyncio
import json
import re
import sys
import os
import argparse
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# MCP imports
from mcp.server import Server
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types
from mcp.server.stdio import stdio_server

# Try to load .env
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("python-dotenv loaded")
except ImportError:
    print("python-dotenv not available")
    # Manual loading fallback
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    key, value = line.strip().split('=', 1)
                    os.environ[key] = value
        print("Manually loaded .env")

# Configuration - can be overridden by environment variables or command line args
script_dir = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REPO_PATH = os.path.dirname(os.path.dirname(script_dir))

# Git imports
try:
    from git import Repo
except ImportError:
    print("GitPython not found. Install with: pip install GitPython")
    sys.exit(1)

class DiffParserMCP:
    def __init__(self, repo_path: str = DEFAULT_REPO_PATH):
        self.repo_path = Path(repo_path)
        self.repo = Repo(repo_path)

    def parse_diff_header(self, diff_text: str) -> Dict[str, Any]:
        """Parse the diff header to extract file information"""
        lines = diff_text.strip().split('\n')

        file_info = {}
        for line in lines:
            if line.startswith('diff --git'):
                # Extract file paths: diff --git a/path b/path
                match = re.match(r'diff --git a/(.*) b/(.*)', line)
                if match:
                    file_info['old_path'] = match.group(1)
                    file_info['new_path'] = match.group(2)
            elif line.startswith('index'):
                # Extract commit hashes: index abc123..def456 100644
                match = re.match(r'index ([a-f0-9]+)\.\.([a-f0-9]+)(?:\s+(\d+))?', line)
                if match:
                    file_info['old_hash'] = match.group(1)
                    file_info['new_hash'] = match.group(2)
                    file_info['mode'] = match.group(3) if match.group(3) else '100644'
            elif line.startswith('---'):
                # Old file: --- a/path/to/file
                file_info['old_file'] = line[4:].strip()
            elif line.startswith('+++'):
                # New file: +++ b/path/to/file
                file_info['new_file'] = line[4:].strip()

        return file_info

    def parse_hunks(self, diff_text: str) -> List[Dict[str, Any]]:
        """Parse diff hunks (the actual changes)"""
        lines = diff_text.strip().split('\n')
        hunks = []
        current_hunk = None

        for line in lines:
            if line.startswith('@@'):
                # Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
                match = re.match(r'@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@', line)
                if match:
                    if current_hunk:
                        hunks.append(current_hunk)

                    current_hunk = {
                        'old_start': int(match.group(1)),
                        'old_count': int(match.group(2)) if match.group(2) else 1,
                        'new_start': int(match.group(3)),
                        'new_count': int(match.group(4)) if match.group(4) else 1,
                        'lines': []
                    }
            elif current_hunk and (line.startswith(' ') or line.startswith('+') or line.startswith('-')):
                # Context, addition, or deletion line
                current_hunk['lines'].append(line)

        if current_hunk:
            hunks.append(current_hunk)

        return hunks

    def apply_hunk_to_file(self, file_path: Path, hunk: Dict[str, Any]) -> bool:
        """Apply a single hunk to a file"""
        try:
            # Read the current file content
            if file_path.exists():
                with open(file_path, 'r', encoding='utf-8') as f:
                    file_lines = f.readlines()
            else:
                file_lines = []

            # Apply the hunk
            old_line_idx = hunk['old_start'] - 1  # Convert to 0-based index
            new_lines = []

            # Process each line in the hunk
            for line in hunk['lines']:
                if line.startswith(' '):
                    # Context line - keep as is
                    new_lines.append(line[1:] + '\n' if not line[1:].endswith('\n') else line[1:])
                elif line.startswith('+'):
                    # Addition - add this line
                    new_lines.append(line[1:] + '\n' if not line[1:].endswith('\n') else line[1:])
                elif line.startswith('-'):
                    # Deletion - skip this line (don't add to new_lines)
                    pass

            # Replace the lines in the file
            result_lines = (
                file_lines[:old_line_idx] +
                new_lines +
                file_lines[old_line_idx + hunk['old_count']:]
            )

            # Ensure parent directory exists
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # Write the modified content back
            with open(file_path, 'w', encoding='utf-8') as f:
                f.writelines(result_lines)

            return True

        except Exception as e:
            print(f"Error applying hunk to {file_path}: {e}")
            return False

    def apply_diff(self, diff_text: str, branch_name: str) -> Dict[str, Any]:
        """Parse and apply a complete diff"""
        try:
            # Switch to the target branch
            self.repo.git.checkout(branch_name)

            # Parse the diff
            file_info = self.parse_diff_header(diff_text)
            hunks = self.parse_hunks(diff_text)

            if not file_info.get('new_path'):
                return {"success": False, "message": "Could not parse file path from diff"}

            if not hunks:
                return {"success": False, "message": "No hunks found in diff"}

            # Apply each hunk
            file_path = self.repo_path / file_info['new_path']

            for hunk in hunks:
                if not self.apply_hunk_to_file(file_path, hunk):
                    return {"success": False, "message": f"Failed to apply hunk at line {hunk['old_start']}"}

            # Stage and commit the changes
            self.repo.git.add(str(file_path))
            self.repo.index.commit(f"Apply diff to {file_info['new_path']}")

            return {
                "success": True,
                "message": f"Successfully applied diff to {file_info['new_path']}",
                "file_path": str(file_path),
                "hunks_applied": len(hunks)
            }

        except Exception as e:
            return {"success": False, "message": f"Error applying diff: {str(e)}"}

    def create_simple_diff(self, file_path: str, additions: List[Dict[str, Any]]) -> str:
        """Create a simple diff with line additions at specific positions"""
        """
        additions format: [
            {"line_number": 571, "content": "    <add key=\"UnifiedAppCombinationPhase2CustomerPercentage\" value=\"0\" />"},
            {"line_number": 574, "content": "UnifiedAppCombinationPhase2,"}
        ]
        """

        # Read current file
        full_path = self.repo_path / file_path
        if full_path.exists():
            with open(full_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        else:
            lines = []

        # Sort additions by line number (reverse order to avoid index shifting)
        sorted_additions = sorted(additions, key=lambda x: x['line_number'], reverse=True)

        # Create the diff
        diff_lines = [
            f"diff --git a/{file_path} b/{file_path}",
            f"index abc123..def456 100644",
            f"--- a/{file_path}",
            f"+++ b/{file_path}"
        ]

        for addition in sorted_additions:
            line_num = addition['line_number']
            content = addition['content']

            # Create hunk header
            diff_lines.append(f"@@ -{line_num},3 +{line_num},4 @@")

            # Add context lines
            if line_num > 1 and line_num - 1 < len(lines):
                diff_lines.append(" " + lines[line_num - 2].rstrip())
            if line_num < len(lines):
                diff_lines.append(" " + lines[line_num - 1].rstrip())

            # Add the new line
            diff_lines.append("+" + content)

            # Add context line after
            if line_num < len(lines):
                diff_lines.append(" " + lines[line_num].rstrip())

        return "\n".join(diff_lines)

# Global variables for configuration
REPO_PATH = DEFAULT_REPO_PATH

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(description='MCP Diff Parser Server')
    parser.add_argument('--repo-path',
                       help='Path to the git repository',
                       default=None)
    return parser.parse_args()

# MCP Server setup
app = Server("diff-parser")

# Global instance (will be initialized with repo path)
diff_parser: Optional[DiffParserMCP] = None

@app.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    """List available tools."""
    return [
        types.Tool(
            name="get_configuration",
            description="Get current diff parser configuration",
            inputSchema={
                "type": "object",
                "properties": {},
                "additionalProperties": False
            }
        ),
        types.Tool(
            name="initialize_repo",
            description="Initialize the diff parser with a repository path",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {
                        "type": "string",
                        "description": "Path to the git repository (optional, uses configured default if not provided)"
                    }
                },
                "additionalProperties": False
            }
        ),
        types.Tool(
            name="apply_diff",
            description="Parse and apply a git diff to a branch",
            inputSchema={
                "type": "object",
                "properties": {
                    "diff_text": {
                        "type": "string",
                        "description": "The git diff text to apply"
                    },
                    "branch_name": {
                        "type": "string",
                        "description": "The branch to apply the diff to"
                    }
                },
                "required": ["diff_text", "branch_name"],
                "additionalProperties": False
            }
        ),
        types.Tool(
            name="create_simple_diff",
            description="Create a simple diff for line additions",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Path to the file (relative to repo root)"
                    },
                    "additions": {
                        "type": "array",
                        "description": "Array of line additions",
                        "items": {
                            "type": "object",
                            "properties": {
                                "line_number": {"type": "integer"},
                                "content": {"type": "string"}
                            },
                            "required": ["line_number", "content"]
                        }
                    }
                },
                "required": ["file_path", "additions"],
                "additionalProperties": False
            }
        )
    ]

@app.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    """Handle tool calls."""
    global diff_parser, REPO_PATH

    if name == "get_configuration":
        return [types.TextContent(type="text", text=json.dumps({
            "current_repo_path": REPO_PATH,
            "parser_initialized": diff_parser is not None,
            "parser_repo_path": str(diff_parser.repo_path) if diff_parser else None
        }, indent=2))]

    elif name == "initialize_repo":
        repo_path = arguments.get("repo_path", REPO_PATH)

        if not repo_path:
            return [types.TextContent(type="text", text="Error: No repo_path provided and no default configured")]

        try:
            diff_parser = DiffParserMCP(repo_path)
            return [types.TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Initialized diff parser with repo: {repo_path}",
                "repo_path": repo_path
            }, indent=2))]
        except Exception as e:
            return [types.TextContent(type="text", text=json.dumps({
                "success": False,
                "message": f"Error initializing repo: {str(e)}",
                "repo_path": repo_path
            }, indent=2))]

    elif name == "apply_diff":
        if not diff_parser:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "Repository not initialized. Call initialize_repo first.",
                "suggestion": f"Use initialize_repo with repo_path or configure default: {REPO_PATH}"
            }, indent=2))]

        diff_text = arguments.get("diff_text")
        branch_name = arguments.get("branch_name")

        if not diff_text or not branch_name:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "diff_text and branch_name are required"
            }, indent=2))]

        result = diff_parser.apply_diff(diff_text, branch_name)
        return [types.TextContent(type="text", text=json.dumps(result, indent=2))]

    elif name == "create_simple_diff":
        if not diff_parser:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "Repository not initialized. Call initialize_repo first.",
                "suggestion": f"Use initialize_repo with repo_path or configure default: {REPO_PATH}"
            }, indent=2))]

        file_path = arguments.get("file_path")
        additions = arguments.get("additions", [])

        if not file_path:
            return [types.TextContent(type="text", text=json.dumps({
                "error": "file_path is required"
            }, indent=2))]

        try:
            diff_text = diff_parser.create_simple_diff(file_path, additions)
            return [types.TextContent(type="text", text=diff_text)]
        except Exception as e:
            return [types.TextContent(type="text", text=json.dumps({
                "error": f"Error creating diff: {str(e)}"
            }, indent=2))]

    else:
        return [types.TextContent(type="text", text=json.dumps({
            "error": f"Unknown tool: {name}"
        }, indent=2))]

async def main():
    global REPO_PATH

    # Parse command line arguments and update configuration
    try:
        args = parse_arguments()

        if args.repo_path:
            REPO_PATH = args.repo_path
            print(f"Using repo path from args: {REPO_PATH}", file=sys.stderr)
        else:
            print(f"Using default repo path: {REPO_PATH}", file=sys.stderr)

    except SystemExit:
        # Handle --help or invalid arguments gracefully
        pass

    print(f"Starting MCP Diff Parser Server with repo path: {REPO_PATH}", file=sys.stderr)

    # Ensure we're using stdin/stdout for VS Code compatibility
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="diff-parser",
                server_version="1.0.0",
                capabilities={
                    "tools": {},  # Add this for tool support
                    "resources": {},  # Optional: if you have resources
                    "prompts": {},   # Optional: if you have prompts
                    "experimental": {},
                    "notification": {
                        "toolsChanged": False
                    }
                }
            )
        )

if __name__ == "__main__":
    # Ensure proper error handling for VS Code
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # Handle graceful shutdown
        print("Shutting down gracefully...", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        # Log errors to stderr so they don't interfere with stdio communication
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)