#!/usr/bin/env node

/**
 * Fast Search MCP Server
 * Provides indexed search for files and content
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

// Index storage
let fileIndex = new Map(); // Map<filepath, {content, size, mtime}>
let contentIndex = new Map(); // Map<word, Set<filepath>>
let isIndexing = false;
let lastIndexTime = null;
const REPO_ROOT = process.cwd();

// Ignore patterns
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'target', 'build', 'dist', 'out', '.venv',
  '.pnpm', '.roo', '.sweagent', 'qconfig', '.azuredevops', '.gdn', 'private'
]);

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.pdf', '.doc', '.docx',
  '.lock', '.log'
]);

/**
 * Use git ls-files for fast file listing (only tracked files)
 */
function getGitFiles() {
  try {
    const output = execSync('git ls-files', {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      cwd: REPO_ROOT
    });
    return output.trim().split('\n').filter(f => f.length > 0);
  } catch (error) {
    console.error('Error getting git files:', error.message);
    return [];
  }
}

/**
 * Check if file should be indexed
 */
function shouldIndexFile(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (IGNORE_EXTENSIONS.has(ext)) return false;

  const parts = filepath.split(path.sep);
  for (const dir of IGNORE_DIRS) {
    if (parts.includes(dir)) return false;
  }

  return true;
}

/**
 * Tokenize content for search
 */
function tokenize(content) {
  // Extract words (alphanumeric + underscore, min 2 chars)
  const words = content.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  return new Set(words);
}

/**
 * Build the index
 */
async function buildIndex() {
  if (isIndexing) {
    return { status: 'already_indexing' };
  }

  isIndexing = true;
  const startTime = Date.now();

  try {
    console.error('Starting index build...');
    const files = getGitFiles();
    console.error(`Found ${files.length} tracked files`);

    fileIndex.clear();
    contentIndex.clear();

    let indexed = 0;
    let skipped = 0;

    // Process files in batches
    const batchSize = 100;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      await Promise.all(batch.map(async (file) => {
        if (!shouldIndexFile(file)) {
          skipped++;
          return;
        }

        const fullPath = path.join(REPO_ROOT, file);
        try {
          const stats = await fs.stat(fullPath);

          // Skip files larger than 1MB to avoid memory issues
          if (stats.size > 1024 * 1024) {
            skipped++;
            return;
          }

          const content = await fs.readFile(fullPath, 'utf8');

          // Store file info
          fileIndex.set(file, {
            content,
            size: stats.size,
            mtime: stats.mtime.getTime()
          });

          // Index content words
          const words = tokenize(content);
          for (const word of words) {
            if (!contentIndex.has(word)) {
              contentIndex.set(word, new Set());
            }
            contentIndex.get(word).add(file);
          }

          indexed++;
        } catch (error) {
          // Skip files that can't be read
          skipped++;
        }
      }));

      if (i % 1000 === 0 && i > 0) {
        console.error(`Indexed ${i}/${files.length} files...`);
      }
    }

    const duration = Date.now() - startTime;
    lastIndexTime = Date.now();

    console.error(`Index built: ${indexed} files indexed, ${skipped} skipped in ${duration}ms`);

    return {
      status: 'success',
      filesIndexed: indexed,
      filesSkipped: skipped,
      durationMs: duration,
      indexSizeMB: (JSON.stringify([...contentIndex.entries()]).length / 1024 / 1024).toFixed(2)
    };
  } finally {
    isIndexing = false;
  }
}

/**
 * Search for files by name pattern
 */
function searchFiles(pattern) {
  const regex = new RegExp(pattern, 'i');
  const results = [];

  for (const filepath of fileIndex.keys()) {
    if (regex.test(filepath)) {
      results.push(filepath);
    }
  }

  return results;
}

/**
 * Search for content
 */
function searchContent(query, options = {}) {
  const { maxResults = 100, includeContext = false } = options;

  // Tokenize query
  const queryWords = query.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  if (queryWords.length === 0) {
    return [];
  }

  // Find files containing all query words
  let matchingFiles = null;
  for (const word of queryWords) {
    const filesWithWord = contentIndex.get(word);
    if (!filesWithWord) {
      return []; // Word not found in any file
    }

    if (matchingFiles === null) {
      matchingFiles = new Set(filesWithWord);
    } else {
      matchingFiles = new Set([...matchingFiles].filter(f => filesWithWord.has(f)));
    }

    if (matchingFiles.size === 0) break;
  }

  if (!matchingFiles || matchingFiles.size === 0) {
    return [];
  }

  // Prepare results
  const results = [];
  const queryRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

  for (const filepath of matchingFiles) {
    if (results.length >= maxResults) break;

    const fileData = fileIndex.get(filepath);
    if (!fileData) continue;

    const result = { file: filepath };

    if (includeContext) {
      // Find matching lines
      const lines = fileData.content.split('\n');
      const matchingLines = [];

      for (let i = 0; i < lines.length; i++) {
        if (queryRegex.test(lines[i])) {
          matchingLines.push({
            line: i + 1,
            content: lines[i].trim(),
          });

          if (matchingLines.length >= 5) break; // Limit to 5 matches per file
        }
      }

      result.matches = matchingLines;
      result.matchCount = matchingLines.length;
    }

    results.push(result);
  }

  return results;
}

/**
 * Get file content from index
 */
function getFileContent(filepath) {
  const fileData = fileIndex.get(filepath);
  if (!fileData) {
    return null;
  }
  return fileData.content;
}

/**
 * Get index stats
 */
function getStats() {
  return {
    filesIndexed: fileIndex.size,
    uniqueWords: contentIndex.size,
    lastIndexTime: lastIndexTime ? new Date(lastIndexTime).toISOString() : null,
    isIndexing,
    indexSizeMB: fileIndex.size > 0 ?
      (JSON.stringify([...contentIndex.entries()].slice(0, 100)).length / 1024 / 1024 * contentIndex.size / 100).toFixed(2) :
      0
  };
}

// Create MCP server
const server = new Server(
  {
    name: "fast-search",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "index_build",
        description: "Build or rebuild the file index. Run this once at startup or when you need to refresh the index.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_files",
        description: "Search for files by name pattern (regex). Very fast, searches only indexed filenames.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Regex pattern to match against file paths (e.g., 'component.*\\.tsx$' or 'api/.*\\.ts')",
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "search_content",
        description: "Search for text within file contents. Very fast, searches the indexed content.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text to search for in file contents",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (default: 100)",
              default: 100,
            },
            includeContext: {
              type: "boolean",
              description: "Include matching lines with context (default: false)",
              default: false,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_file_content",
        description: "Get the content of a file from the index (very fast, no disk access)",
        inputSchema: {
          type: "object",
          properties: {
            filepath: {
              type: "string",
              description: "Path to the file relative to repository root",
            },
          },
          required: ["filepath"],
        },
      },
      {
        name: "index_stats",
        description: "Get statistics about the current index",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "index_build": {
        const result = await buildIndex();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "search_files": {
        const results = searchFiles(args.pattern);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.join('\n')
              : 'No files found matching pattern'
          }],
        };
      }

      case "search_content": {
        const results = searchContent(args.query, {
          maxResults: args.maxResults || 100,
          includeContext: args.includeContext || false,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found" }],
          };
        }

        if (args.includeContext) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify(results, null, 2)
            }],
          };
        } else {
          return {
            content: [{
              type: "text",
              text: results.map(r => r.file).join('\n')
            }],
          };
        }
      }

      case "get_file_content": {
        const content = getFileContent(args.filepath);
        if (!content) {
          return {
            content: [{ type: "text", text: `File not found in index: ${args.filepath}` }],
          };
        }
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "index_stats": {
        const stats = getStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fast Search MCP Server running on stdio");

  // Build index on startup
  console.error("Building initial index...");
  await buildIndex();
}

main().catch(console.error);
