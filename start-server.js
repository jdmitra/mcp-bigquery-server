#!/usr/bin/env node

/**
 * Wrapper script for starting the BigQuery MCP server
 * This helps Claude desktop find the correct path to the server
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

// Get the absolute path to the directory where this script is located (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const distPath = path.join(rootDir, 'dist', 'index.js');

// Check if the dist folder exists
if (!fs.existsSync(path.join(rootDir, 'dist'))) {
  console.error('Error: dist directory not found. Please run "npm run build" first.');
  process.exit(1);
}

// Check if the compiled JavaScript file exists
if (!fs.existsSync(distPath)) {
  console.error('Error: dist/index.js not found. Please run "npm run build" first.');
  process.exit(1);
}

// Default configuration
const projectId = 'bestreviews-200115';
const keyFilePath = path.join(rootDir, 'bestreviews-200115-38ee35ffe54f.json');
const location = 'US';

console.error(`Starting BigQuery MCP server with:`);
console.error(`- Project ID: ${projectId}`);
console.error(`- Key file: ${keyFilePath}`);
console.error(`- Location: ${location}`);

// Spawn the server process
const serverProcess = spawn('node', [
  distPath,
  '--project-id', projectId,
  '--key-file', keyFilePath,
  '--location', location
], {
  stdio: 'inherit' // This will pipe the child process I/O to the parent
});

// Handle the server process events
serverProcess.on('error', (err) => {
  console.error(`Failed to start server process: ${err}`);
  process.exit(1);
});

serverProcess.on('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`Server process exited with code ${code} and signal ${signal}`);
    process.exit(code || 1);
  }
});

// Make sure we handle termination gracefully
process.on('SIGINT', () => {
  serverProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  serverProcess.kill('SIGTERM');
});