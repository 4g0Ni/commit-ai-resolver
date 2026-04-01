#!/usr/bin/env python3
"""
MCP Server for Browser Use - VS Code LLM Control
Provides direct browser automation capabilities through MCP protocol
VS Code's LLM drives the browser actions directly
"""

import asyncio
import base64
import json
import argparse
import os
import sys
import uuid
from typing import Any, Dict, List, Optional, Tuple
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import (
    Resource,
    Tool,
    TextContent,
    ImageContent,
    EmbeddedResource,
)

import logging
from datetime import datetime, timedelta

# Set environment variables before importing browser_use
os.environ['PYTHONIOENCODING'] = 'utf-8'

if sys.platform.startswith('win'):
    os.environ['PYTHONUTF8'] = '1'

# Fix encoding issues at the system level
if sys.platform.startswith('win'):
    import codecs
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'replace')
        sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'replace')

from browser_use.browser.browser import Browser
from browser_use.browser.context import BrowserContext

# Try to load .env
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("✅ python-dotenv loaded")
except ImportError:
    print("❌ python-dotenv not available")
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    key, value = line.strip().split('=', 1)
                    os.environ[key] = value
        print("✅ Manually loaded .env")

# Configuration defaults
DEFAULT_CONFIG = {
    "headless": os.getenv("BROWSER_HEADLESS", "false").lower() == "true",
    "viewport_width": int(os.getenv("BROWSER_WIDTH", "1280")),
    "viewport_height": int(os.getenv("BROWSER_HEIGHT", "720")),
    "session_timeout_hours": float(os.getenv("SESSION_TIMEOUT_HOURS", "1.0")),
    "max_sessions_per_user": int(os.getenv("MAX_SESSIONS_PER_USER", "5"))
}

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class BrowserSessionManager:
    """Manages browser sessions with automatic cleanup"""

    def __init__(self, config: Dict[str, Any]):
        self.browser_sessions: Dict[str, BrowserContext] = {}
        self.session_goals: Dict[str, str] = {}
        self.session_last_activity: Dict[str, Tuple[datetime, str]] = {}
        self.browser: Optional[Browser] = None
        self.config = config
        self._browser_starting = False

    async def _ensure_browser_started(self):
        """Lazy initialization - start browser only when first needed"""
        if self.browser is not None:
            return  # Already started

        if self._browser_starting:
            # Another request is already starting the browser, wait for it
            while self._browser_starting:
                await asyncio.sleep(0.1)
            return

        try:
            self._browser_starting = True
            print("🚀 Starting browser (lazy initialization)...", file=sys.stderr)

            self.browser = Browser(
                headless=self.config["headless"],
                viewport=(self.config["viewport_width"], self.config["viewport_height"])
            )
            await self.browser.start()

            print("✅ Browser started successfully", file=sys.stderr)
        except Exception as e:
            print(f"❌ Failed to start browser: {e}", file=sys.stderr)
            self.browser = None
            raise
        finally:
            self._browser_starting = False

    async def create_session(self, user_id: str, goal: str = "Browse the web") -> str:
        """Create a new browser session"""
        await self._ensure_browser_started()  # Lazy start browser

        if not self.browser:
            raise Exception("Failed to initialize browser")

        # Check user session limit
        user_sessions = self.get_user_sessions(user_id)
        if len(user_sessions) >= self.config["max_sessions_per_user"]:
            raise Exception(f"User {user_id} has reached maximum sessions limit ({self.config['max_sessions_per_user']})")

        session_id = str(uuid.uuid4())
        context = await self.browser.new_context()

        self.browser_sessions[session_id] = context
        self.session_goals[session_id] = goal
        self.session_last_activity[session_id] = (datetime.now(), user_id)

        print(f"📱 Created new session {session_id[:8]}... for user {user_id}", file=sys.stderr)
        return session_id

    def get_session(self, session_id: str) -> Optional[BrowserContext]:
        """Get browser session by ID and update activity timestamp"""
        session = self.browser_sessions.get(session_id)
        if session and session_id in self.session_last_activity:
            _, user_id = self.session_last_activity[session_id]
            self.session_last_activity[session_id] = (datetime.now(), user_id)
        return session

    async def close_session(self, session_id: str):
        """Close a browser session"""
        context = self.browser_sessions.get(session_id)
        if context:
            try:
                await context.close()
                print(f"🗑️ Closed session {session_id[:8]}...", file=sys.stderr)
            except Exception as e:
                logger.warning(f"Error closing session {session_id}: {e}")
            finally:
                self._remove_session(session_id)

    async def cleanup_and_shutdown(self):
        """Clean up all sessions and shut down browser"""
        print("🧹 Cleaning up all sessions...", file=sys.stderr)

        # Close all sessions
        for session_id in list(self.browser_sessions.keys()):
            await self.close_session(session_id)

        # Close browser
        if self.browser:
            try:
                await self.browser.close()
                print("🛑 Browser shut down", file=sys.stderr)
            except Exception as e:
                logger.warning(f"Error shutting down browser: {e}")
            finally:
                self.browser = None

    def _remove_session(self, session_id: str):
        """Remove session from tracking"""
        self.browser_sessions.pop(session_id, None)
        self.session_goals.pop(session_id, None)
        self.session_last_activity.pop(session_id, None)

    def get_user_sessions(self, user_id: str) -> List[str]:
        """Get all session IDs for a specific user"""
        return [session_id for session_id, (_, uid) in self.session_last_activity.items()
                if uid == user_id and session_id in self.browser_sessions]

    async def cleanup_inactive_sessions(self, timeout_hours: float = None) -> Dict[str, Any]:
        """Clean up inactive sessions"""
        if timeout_hours is None:
            timeout_hours = self.config["session_timeout_hours"]

        cutoff_time = datetime.now() - timedelta(hours=timeout_hours)
        inactive_sessions = []

        for session_id, (last_activity, user_id) in self.session_last_activity.items():
            if last_activity < cutoff_time:
                inactive_sessions.append(session_id)

        cleanup_results = {"cleaned_up": [], "failed": [], "total_cleaned": 0}

        for session_id in inactive_sessions:
            try:
                await self.close_session(session_id)
                cleanup_results["cleaned_up"].append(session_id)
            except Exception as e:
                cleanup_results["failed"].append({"session_id": session_id, "error": str(e)})

        cleanup_results["total_cleaned"] = len(cleanup_results["cleaned_up"])
        return cleanup_results

    def get_session_info(self) -> Dict[str, Any]:
        """Get information about all active sessions"""
        current_time = datetime.now()
        session_info = {
            "total_sessions": len(self.browser_sessions),
            "sessions": [],
            "user_session_counts": {}
        }

        for session_id in self.browser_sessions.keys():
            last_activity_data = self.session_last_activity.get(session_id, (current_time, "unknown"))
            last_activity, user_id = last_activity_data
            inactive_duration = current_time - last_activity

            session_info["sessions"].append({
                "session_id": session_id,
                "user_id": user_id,
                "last_activity": last_activity.isoformat(),
                "inactive_minutes": int(inactive_duration.total_seconds() / 60),
                "goal": self.session_goals.get(session_id, "No goal set")
            })

        # User session counts
        user_counts = {}
        for session_id, (_, user_id) in self.session_last_activity.items():
            if session_id in self.browser_sessions:
                user_counts[user_id] = user_counts.get(user_id, 0) + 1

        session_info["user_session_counts"] = {
            user_id: {
                "session_count": count,
                "max_sessions": self.config["max_sessions_per_user"]
            }
            for user_id, count in user_counts.items()
        }

        return session_info

class BrowserMCPServer:
    def __init__(self, config: Dict[str, Any]):
        self.server = Server("browser-use-server")
        self.config = config
        self.session_manager = BrowserSessionManager(config)  # Pass config to session manager
        self.setup_handlers()

    # Remove the initialize method since we're using lazy initialization

    def setup_handlers(self):
        @self.server.list_tools()
        async def handle_list_tools() -> List[Tool]:
            return [
                Tool(
                    name="create_browser_session",
                    description="Create a new browser session",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "user_id": {"type": "string", "description": "User identifier"},
                            "goal": {"type": "string", "description": "Goal for this session", "default": "Browse the web"}
                        },
                        "required": ["user_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="close_browser_session",
                    description="Close a browser session",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Session ID to close"}
                        },
                        "required": ["session_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="navigate_to_url",
                    description="Navigate to a specific URL",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "url": {"type": "string", "description": "URL to navigate to"}
                        },
                        "required": ["session_id", "url"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="get_page_content",
                    description="Get the current page content (text and HTML)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "include_html": {"type": "boolean", "description": "Include raw HTML", "default": False}
                        },
                        "required": ["session_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="get_clickable_elements",
                    description="Get a list of all clickable elements on the page with descriptions",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "element_types": {"type": "array", "items": {"type": "string"}, "description": "Types of elements to find", "default": ["button", "a", "input[type=submit]", "[onclick]", "[role=button]"]}
                        },
                        "required": ["session_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="click_element_by_description",
                    description="Click an element by describing what it looks like or contains",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "description": {"type": "string", "description": "Description of the element (e.g., 'blue login button', 'link that says Contact Us')"},
                            "timeout": {"type": "number", "description": "Timeout in seconds", "default": 10}
                        },
                        "required": ["session_id", "description"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="click_element",
                    description="Click on an element by selector",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "selector": {"type": "string", "description": "CSS selector for the element"},
                            "timeout": {"type": "number", "description": "Timeout in seconds", "default": 10}
                        },
                        "required": ["session_id", "selector"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="type_text",
                    description="Type text into an input field",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "selector": {"type": "string", "description": "CSS selector for the input field"},
                            "text": {"type": "string", "description": "Text to type"},
                            "clear_first": {"type": "boolean", "description": "Clear field before typing", "default": True}
                        },
                        "required": ["session_id", "selector", "text"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="wait_for_element",
                    description="Wait for an element to appear on the page",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "selector": {"type": "string", "description": "CSS selector for the element"},
                            "timeout": {"type": "number", "description": "Timeout in seconds", "default": 10}
                        },
                        "required": ["session_id", "selector"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="scroll_page",
                    description="Scroll the page",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "direction": {"type": "string", "enum": ["up", "down"], "description": "Scroll direction"},
                            "amount": {"type": "number", "description": "Scroll amount in pixels", "default": 500}
                        },
                        "required": ["session_id", "direction"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="get_session_info",
                    description="Get information about browser sessions",
                    inputSchema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="cleanup_inactive_sessions",
                    description="Clean up inactive browser sessions",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "timeout_hours": {"type": "number", "description": "Hours of inactivity before cleanup", "default": 1.0}
                        },
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="take_screenshot",
                    description="Take a screenshot of the current page. Returns base64 PNG image.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "full_page": {"type": "boolean", "description": "Capture full scrollable page", "default": False}
                        },
                        "required": ["session_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="wait_for_text",
                    description="Wait for specific text to appear anywhere on the page",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "text": {"type": "string", "description": "Text to wait for"},
                            "timeout": {"type": "number", "description": "Timeout in seconds", "default": 10}
                        },
                        "required": ["session_id", "text"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="wait_for_load",
                    description="Wait for page to finish loading (network idle)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "state": {"type": "string", "enum": ["load", "domcontentloaded", "networkidle"], "description": "Wait condition", "default": "networkidle"},
                            "timeout": {"type": "number", "description": "Timeout in seconds", "default": 30}
                        },
                        "required": ["session_id"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="evaluate_script",
                    description="Execute JavaScript and return the result. Use for queries like 'is button disabled?', 'how many rows?'",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "script": {"type": "string", "description": "JavaScript expression to evaluate"}
                        },
                        "required": ["session_id", "script"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="press_key",
                    description="Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "key": {"type": "string", "description": "Key to press (Enter, Escape, Tab, ArrowUp, ArrowDown, etc.)"},
                            "selector": {"type": "string", "description": "Optional: CSS selector to focus first"}
                        },
                        "required": ["session_id", "key"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="fill_form",
                    description="Fill multiple form fields by label, placeholder, or name. E.g., {'Email': 'test@test.com', 'Password': 'xxx'}",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "session_id": {"type": "string", "description": "Browser session ID"},
                            "fields": {"type": "object", "description": "Object mapping field labels/names to values"},
                            "submit": {"type": "boolean", "description": "Press Enter after filling", "default": False}
                        },
                        "required": ["session_id", "fields"],
                        "additionalProperties": False
                    }
                ),
                Tool(
                    name="connect_to_existing_browser",
                    description="Connect to an existing browser instance via Chrome DevTools Protocol (CDP) WebSocket URL. Use this to connect to a browser opened by a test runner with --expose-browser flag.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "cdp_url": {"type": "string", "description": "The CDP WebSocket URL (e.g., ws://127.0.0.1:9222/devtools/browser/abc-123)"},
                            "session_id": {"type": "string", "description": "Optional session ID to use. If not provided, a new one will be generated."}
                        },
                        "required": ["cdp_url"],
                        "additionalProperties": False
                    }
                )
            ]

        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
            try:
                if name == "create_browser_session":
                    return await self._create_browser_session(arguments)
                elif name == "close_browser_session":
                    return await self._close_browser_session(arguments)
                elif name == "navigate_to_url":
                    return await self._navigate_to_url(arguments)
                elif name == "get_page_content":
                    return await self._get_page_content(arguments)
                elif name == "get_clickable_elements":
                    return await self._get_clickable_elements(arguments)
                elif name == "click_element_by_description":
                    return await self._click_element_by_description(arguments)
                elif name == "click_element":
                    return await self._click_element(arguments)
                elif name == "type_text":
                    return await self._type_text(arguments)
                elif name == "wait_for_element":
                    return await self._wait_for_element(arguments)
                elif name == "scroll_page":
                    return await self._scroll_page(arguments)
                elif name == "get_browser_status":
                    return await self._get_browser_status(arguments)
                elif name == "get_session_info":
                    return await self._get_session_info(arguments)
                elif name == "cleanup_inactive_sessions":
                    return await self._cleanup_inactive_sessions(arguments)
                elif name == "take_screenshot":
                    return await self._take_screenshot(arguments)
                elif name == "wait_for_text":
                    return await self._wait_for_text(arguments)
                elif name == "wait_for_load":
                    return await self._wait_for_load(arguments)
                elif name == "evaluate_script":
                    return await self._evaluate_script(arguments)
                elif name == "press_key":
                    return await self._press_key(arguments)
                elif name == "fill_form":
                    return await self._fill_form(arguments)
                elif name == "connect_to_existing_browser":
                    return await self._connect_to_existing_browser(arguments)
                else:
                    return [TextContent(type="text", text=f"Unknown tool: {name}")]
            except Exception as e:
                logger.error(f"Error executing tool {name}: {str(e)}")
                return [TextContent(type="text", text=f"Error: {str(e)}")]

    async def _create_browser_session(self, arguments: Dict[str, Any]) -> List[TextContent]:
        user_id = arguments.get("user_id")
        goal = arguments.get("goal", "Browse the web")

        try:
            session_id = await self.session_manager.create_session(user_id, goal)
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "session_id": session_id,
                "user_id": user_id,
                "goal": goal
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _close_browser_session(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")

        try:
            await self.session_manager.close_session(session_id)
            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Session {session_id} closed successfully"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _navigate_to_url(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        url = arguments.get("url")

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            await page.goto(url)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Navigated to {url}",
                "current_url": page.url
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _get_page_content(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        include_html = arguments.get("include_html", False)

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            # Get text content
            text_content = await page.evaluate("document.body.innerText")

            result = {
                "success": True,
                "url": page.url,
                "title": await page.title(),
                "text_content": text_content[:5000]  # Limit to prevent huge responses
            }

            if include_html:
                html_content = await page.content()
                result["html_content"] = html_content[:10000]  # Limit HTML too

            return [TextContent(type="text", text=json.dumps(result, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _get_clickable_elements(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        element_types = arguments.get("element_types", ["button", "a", "input[type=submit]", "[onclick]", "[role=button]"])

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            # Get clickable elements with their descriptions
            elements_info = await page.evaluate("""
                (elementTypes) => {
                    let elements = [];

                    // Find elements based on provided types
                    elementTypes.forEach(selector => {
                        document.querySelectorAll(selector).forEach((el, index) => {
                            if (el.offsetParent !== null) { // Only visible elements
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    elements.push({
                                        tag: el.tagName.toLowerCase(),
                                        text: (el.textContent || el.value || el.placeholder || '').trim().slice(0, 100),
                                        attributes: {
                                            id: el.id || '',
                                            class: el.className || '',
                                            type: el.type || '',
                                            href: el.href || '',
                                            title: el.title || '',
                                            'aria-label': el.getAttribute('aria-label') || ''
                                        },
                                        selector: generateSelector(el),
                                        position: {
                                            x: Math.round(rect.left + rect.width / 2),
                                            y: Math.round(rect.top + rect.height / 2)
                                        }
                                    });
                                }
                            }
                        });
                    });

                    function generateSelector(el) {
                        if (el.id) return `#${el.id}`;
                        if (el.className) {
                            const classes = el.className.split(' ').filter(c => c.length > 0);
                            if (classes.length > 0) return `${el.tagName.toLowerCase()}.${classes[0]}`;
                        }
                        return el.tagName.toLowerCase();
                    }

                    return elements.slice(0, 50); // Limit to prevent huge responses
                }
            """, element_types)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "elements": elements_info,
                "total_found": len(elements_info)
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _click_element_by_description(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        description = arguments.get("description")
        timeout = arguments.get("timeout", 10) * 1000

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            # Find element matching the description
            matching_selector = await page.evaluate("""
                (description) => {
                    const desc = description.toLowerCase();

                    // Common clickable element selectors
                    const selectors = [
                        'button', 'a', 'input[type="submit"]', 'input[type="button"]',
                        '[onclick]', '[role="button"]', 'select'
                    ];

                    for (let selector of selectors) {
                        const elements = document.querySelectorAll(selector);
                        for (let el of elements) {
                            if (el.offsetParent === null) continue; // Skip hidden elements

                            const text = (el.textContent || el.value || el.placeholder || '').toLowerCase();
                            const title = (el.title || '').toLowerCase();
                            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                            const className = (el.className || '').toLowerCase();

                            // Check if description matches text content, attributes, or classes
                            if (text.includes(desc) ||
                                title.includes(desc) ||
                                ariaLabel.includes(desc) ||
                                className.includes(desc) ||
                                (desc.includes('button') && el.tagName.toLowerCase() === 'button') ||
                                (desc.includes('link') && el.tagName.toLowerCase() === 'a')) {

                                // Generate a specific selector for this element
                                if (el.id) return `#${el.id}`;
                                if (el.className) {
                                    const classes = el.className.split(' ').filter(c => c.length > 0);
                                    if (classes.length > 0) return `${el.tagName.toLowerCase()}.${classes[0]}`;
                                }

                                // Fallback: use text content for selection
                                if (text) {
                                    return `${el.tagName.toLowerCase()}:contains("${text.slice(0, 30)}")`;
                                }

                                return el.tagName.toLowerCase();
                            }
                        }
                    }

                    return null;
                }
            """, description)

            if not matching_selector:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": f"No element found matching description: {description}"
                }, indent=2))]

            # Special handling for :contains selector (not native CSS)
            if ":contains(" in matching_selector:
                await page.evaluate(f"""
                    const elements = Array.from(document.querySelectorAll('{matching_selector.split(':contains(')[0]}'));
                    const targetText = '{matching_selector.split(':contains("')[1].split('")')[0]}';
                    const element = elements.find(el => el.textContent.includes(targetText));
                    if (element) element.click();
                """)
            else:
                await page.click(matching_selector, timeout=timeout)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Clicked element matching: {description}",
                "selector_used": matching_selector
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _click_element(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        selector = arguments.get("selector")
        timeout = arguments.get("timeout", 10) * 1000  # Convert to milliseconds

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            await page.click(selector, timeout=timeout)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Clicked element: {selector}"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _type_text(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        selector = arguments.get("selector")
        text = arguments.get("text")
        clear_first = arguments.get("clear_first", True)

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            if clear_first:
                await page.fill(selector, "")

            await page.type(selector, text)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Typed text into {selector}"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _wait_for_element(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        selector = arguments.get("selector")
        timeout = arguments.get("timeout", 10) * 1000  # Convert to milliseconds

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            await page.wait_for_selector(selector, timeout=timeout)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Element found: {selector}"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _scroll_page(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        direction = arguments.get("direction")
        amount = arguments.get("amount", 500)

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            if direction == "down":
                await page.evaluate(f"window.scrollBy(0, {amount})")
            else:  # up
                await page.evaluate(f"window.scrollBy(0, -{amount})")

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Scrolled {direction} by {amount} pixels"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _get_browser_status(self, arguments: Dict[str, Any]) -> List[TextContent]:
        try:
            status = {
                "browser_running": self.session_manager.browser is not None,
                "browser_starting": self.session_manager._browser_starting,
                "total_sessions": len(self.session_manager.browser_sessions),
                "config": self.config
            }

            if self.session_manager.browser:
                status["message"] = "Browser is running and ready"
            elif self.session_manager._browser_starting:
                status["message"] = "Browser is starting up..."
            else:
                status["message"] = "Browser not started yet (will start on first session creation)"

            return [TextContent(type="text", text=json.dumps(status, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _get_session_info(self, arguments: Dict[str, Any]) -> List[TextContent]:
        try:
            session_info = self.session_manager.get_session_info()
            session_info["browser_status"] = {
                "running": self.session_manager.browser is not None,
                "starting": self.session_manager._browser_starting
            }
            return [TextContent(type="text", text=json.dumps(session_info, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _cleanup_inactive_sessions(self, arguments: Dict[str, Any]) -> List[TextContent]:
        timeout_hours = arguments.get("timeout_hours", DEFAULT_CONFIG["session_timeout_hours"])

        try:
            cleanup_results = await self.session_manager.cleanup_inactive_sessions(timeout_hours)
            return [TextContent(type="text", text=json.dumps(cleanup_results, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    # @aiContributed-MAPFuse-2026-01-13
    async def _take_screenshot(self, arguments: Dict[str, Any]) -> List[TextContent | ImageContent]:
        session_id = arguments.get("session_id")
        full_page = arguments.get("full_page", False)

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            screenshot_bytes = await page.screenshot(full_page=full_page)
            screenshot_b64 = base64.b64encode(screenshot_bytes).decode('utf-8')

            return [
                ImageContent(type="image", data=screenshot_b64, mimeType="image/png"),
                TextContent(type="text", text=json.dumps({
                    "success": True,
                    "url": page.url,
                    "title": await page.title(),
                    "full_page": full_page
                }, indent=2))
            ]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _wait_for_text(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        text = arguments.get("text")
        timeout = arguments.get("timeout", 10) * 1000

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            # Use Playwright's text locator
            await page.get_by_text(text, exact=False).first.wait_for(timeout=timeout)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Text found: '{text}'"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": f"Text '{text}' not found within timeout: {str(e)}"
            }, indent=2))]

    async def _wait_for_load(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        state = arguments.get("state", "networkidle")
        timeout = arguments.get("timeout", 30) * 1000

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            await page.wait_for_load_state(state, timeout=timeout)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Page reached '{state}' state",
                "url": page.url
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _evaluate_script(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        script = arguments.get("script")

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            result = await page.evaluate(script)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "result": result
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _press_key(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        key = arguments.get("key")
        selector = arguments.get("selector")

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()

            if selector:
                await page.click(selector)

            await page.keyboard.press(key)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "message": f"Pressed key: {key}"
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _fill_form(self, arguments: Dict[str, Any]) -> List[TextContent]:
        session_id = arguments.get("session_id")
        fields = arguments.get("fields", {})
        submit = arguments.get("submit", False)

        context = self.session_manager.get_session(session_id)
        if not context:
            return [TextContent(type="text", text="Session not found")]

        try:
            page = await context.get_current_page()
            filled_fields = []
            failed_fields = []

            for field_name, value in fields.items():
                try:
                    # Try multiple strategies to find the input
                    # 1. By label
                    label_input = page.get_by_label(field_name, exact=False)
                    if await label_input.count() > 0:
                        await label_input.first.fill(str(value))
                        filled_fields.append(field_name)
                        continue

                    # 2. By placeholder
                    placeholder_input = page.get_by_placeholder(field_name, exact=False)
                    if await placeholder_input.count() > 0:
                        await placeholder_input.first.fill(str(value))
                        filled_fields.append(field_name)
                        continue

                    # 3. By name attribute
                    name_input = page.locator(f'input[name*="{field_name}" i], textarea[name*="{field_name}" i]')
                    if await name_input.count() > 0:
                        await name_input.first.fill(str(value))
                        filled_fields.append(field_name)
                        continue

                    # 4. By aria-label
                    aria_input = page.locator(f'[aria-label*="{field_name}" i]')
                    if await aria_input.count() > 0:
                        await aria_input.first.fill(str(value))
                        filled_fields.append(field_name)
                        continue

                    failed_fields.append({"field": field_name, "error": "Field not found"})
                except Exception as field_error:
                    failed_fields.append({"field": field_name, "error": str(field_error)})

            if submit and filled_fields:
                await page.keyboard.press("Enter")

            return [TextContent(type="text", text=json.dumps({
                "success": len(failed_fields) == 0,
                "filled_fields": filled_fields,
                "failed_fields": failed_fields,
                "submitted": submit and len(filled_fields) > 0
            }, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2))]

    async def _connect_to_existing_browser(self, arguments: Dict[str, Any]) -> List[TextContent]:
        """Connect to an existing browser via CDP WebSocket URL."""
        cdp_url = arguments.get("cdp_url")
        session_id = arguments.get("session_id") or str(uuid.uuid4())

        if not cdp_url:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": "cdp_url is required"
            }, indent=2))]

        try:
            from playwright.async_api import async_playwright

            # Start Playwright and connect via CDP
            playwright = await async_playwright().start()
            browser = await playwright.chromium.connect_over_cdp(cdp_url)

            # Get existing context and page
            contexts = browser.contexts
            if not contexts:
                return [TextContent(type="text", text=json.dumps({
                    "success": False,
                    "error": "No browser contexts found in connected browser"
                }, indent=2))]

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # Create a wrapper that mimics BrowserContext interface
            class CDPBrowserContextWrapper:
                def __init__(self, playwright_instance, browser_instance, context_instance, page_instance):
                    self._playwright = playwright_instance
                    self._browser = browser_instance
                    self._context = context_instance
                    self._page = page_instance
                    self.connected_via_cdp = True

                async def get_current_page(self):
                    return self._page

                async def close(self):
                    # Don't close the browser, just disconnect
                    try:
                        await self._browser.close()
                        await self._playwright.stop()
                    except Exception:
                        pass

            wrapper = CDPBrowserContextWrapper(playwright, browser, context, page)

            # Store in session manager
            self.session_manager.browser_sessions[session_id] = wrapper
            self.session_manager.session_goals[session_id] = "Debug failing test via CDP"
            self.session_manager.session_last_activity[session_id] = (datetime.now(), "cdp_connection")

            # Get current page info
            current_url = page.url
            title = await page.title()

            print(f"🔗 Connected to existing browser via CDP: {session_id[:8]}...", file=sys.stderr)

            return [TextContent(type="text", text=json.dumps({
                "success": True,
                "session_id": session_id,
                "connected_via": "CDP",
                "cdp_url": cdp_url,
                "current_url": current_url,
                "title": title,
                "num_contexts": len(contexts),
                "num_pages": len(pages)
            }, indent=2))]

        except Exception as e:
            return [TextContent(type="text", text=json.dumps({
                "success": False,
                "error": str(e),
                "cdp_url": cdp_url
            }, indent=2))]

    def _safe_print(self, message: str):
        try:
            print(message, file=sys.stderr)
        except UnicodeEncodeError:
            safe_message = message.encode('ascii', 'replace').decode('ascii')
            print(safe_message, file=sys.stderr)

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(description='MCP Browser Use Server for VS Code')
    parser.add_argument('--headless', action='store_true', help='Run browser in headless mode')
    parser.add_argument('--viewport-width', type=int, default=1280, help='Browser viewport width')
    parser.add_argument('--viewport-height', type=int, default=720, help='Browser viewport height')
    parser.add_argument('--session-timeout', type=float, default=1.0, help='Session timeout in hours')
    parser.add_argument('--max-sessions', type=int, default=5, help='Max sessions per user')
    return parser.parse_args()

def update_config_from_args(config: Dict[str, Any]) -> Dict[str, Any]:
    """Update configuration from command line arguments"""
    try:
        args = parse_arguments()

        if args.headless:
            config["headless"] = True
        if args.viewport_width:
            config["viewport_width"] = args.viewport_width
        if args.viewport_height:
            config["viewport_height"] = args.viewport_height
        if args.session_timeout:
            config["session_timeout_hours"] = args.session_timeout
        if args.max_sessions:
            config["max_sessions_per_user"] = args.max_sessions

    except SystemExit:
        pass

    return config

async def main():
    """Main server function"""
    config = DEFAULT_CONFIG.copy()
    config = update_config_from_args(config)

    print("🚀 Starting MCP Browser Server for VS Code with lazy initialization", file=sys.stderr)
    print("📋 Configuration:", file=sys.stderr)
    for key, value in config.items():
        print(f"  {key}: {value}", file=sys.stderr)
    print("⏳ Browser will start when first session is created", file=sys.stderr)

    browser_server = BrowserMCPServer(config)

    try:
        async with stdio_server() as (read_stream, write_stream):
            await browser_server.server.run(
                read_stream,
                write_stream,
                InitializationOptions(
                    server_name="browser-use-server",
                    server_version="1.0.0",
                    capabilities=browser_server.server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    )
                )
            )
    except KeyboardInterrupt:
        print("\n🛑 Shutting down server...", file=sys.stderr)
    except Exception as e:
        print(f"❌ Server error: {e}", file=sys.stderr)
    finally:
        # Clean shutdown
        try:
            await browser_server.session_manager.cleanup_and_shutdown()
        except Exception as e:
            print(f"⚠️ Error during cleanup: {e}", file=sys.stderr)

if __name__ == "__main__":
    asyncio.run(main())