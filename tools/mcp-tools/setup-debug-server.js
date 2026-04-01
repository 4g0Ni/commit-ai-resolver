#!/usr/bin/env node

/**
 * Debug Script Runner MCP Server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'path';

// MCP Server setup
const server = new Server(
  {
    name: 'debug-script-runner',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_debug_setup_command',
        description: 'Get the PowerShell command to run the debug setup script',
        inputSchema: {
          type: 'object',
          properties: {
            debugType: {
              type: 'string',
              enum: ['int', 'onebox'],
              description: 'Type of debug server to start (int or onebox)',
              default: 'int'
            },
            rootPath: {
              type: 'string',
              description: 'Root path of your project (optional - defaults to current directory)',
            }
          },
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'get_debug_setup_command') {
    const debugType = args?.debugType || 'int';
    const rootPath = args?.rootPath || process.cwd();
    const scriptPath = path.join(rootPath, 'tools', 'mcp-tools', 'setup-local-debug.ps1');

    return {
      content: [
        {
          type: 'text',
          text: `& "${scriptPath}" -DebugType ${debugType}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${name}`,
      },
    ],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Debug Script Runner MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
