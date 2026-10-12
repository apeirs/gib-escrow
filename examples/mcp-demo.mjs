// Minimal MCP client: starts gib-escrow-mcp over stdio, lists its tools and checks one bounty.
// node examples/mcp-demo.mjs [task-id]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = new URL('../bin/gib-escrow-mcp.js', import.meta.url).pathname;
const client = new Client({ name: 'gib-escrow-demo', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: process.env }));
const { tools } = await client.listTools();
console.log('tools:', tools.map(t => t.name).join(', '));
const task = process.argv[2] || '1052f22d-3f87-4b1d-b0d7-71a60679e7fa';
const res = await client.callTool({ name: 'check_bounty_funding', arguments: { task } });
const r = JSON.parse(res.content[0].text);
console.log(`check_bounty_funding(${task}) -> ${r.verdict}, ${r.escrow?.remaining} ${r.escrow?.symbol} left`);
for (const n of r.notes) console.log('  note:', n);
await client.close();
