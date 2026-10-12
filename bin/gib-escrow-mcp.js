#!/usr/bin/env node
// MCP server (stdio) so an agent can check a Gibwork bounty's escrow before it spends a submission fee on it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkTask, scan, stranded } from '../src/report.js';

const server = new McpServer({ name: 'gib-escrow', version: '0.1.0' });
const asText = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

server.tool(
  'check_bounty_funding',
  'Find a Gibwork bounty\'s Solana escrow and report what is really left in it. Verdict FUNDED / LOW / NO_ESCROW plus notes. '
  + 'Use before submitting work (submissions cost a fee) to avoid drained or stale bounties.',
  {
    task: z.string().describe('Gibwork task UUID or gib.work/bounty/... URL'),
    history: z.boolean().optional().describe('Also list every deposit, payout and refund (slower: one RPC call per transaction)'),
    maker: z.string().optional().describe('Creator wallet, to find an escrow that was already closed'),
  },
  async ({ task, history, maker }) => asText(await checkTask(task, { history: !!history, maker })),
);

server.tool(
  'scan_funded_bounties',
  'List every live Gibwork escrow with the money left in it, joined with the open-bounty feed and ranked by money left per submission. '
  + 'Also lists open bounties that have no live escrow.',
  { min_remaining: z.number().optional().describe('Hide escrows holding less than this many token units') },
  async ({ min_remaining }) => asText(await scan({ minRemaining: min_remaining ?? 0 })),
);

server.tool(
  'list_stranded_escrows',
  'Escrows that still hold money for bounties no longer on the open feed (ended or closed). Creators can refund these.',
  { min_remaining: z.number().optional().describe('Hide escrows holding less than this many token units') },
  async ({ min_remaining }) => asText(await stranded({ minRemaining: min_remaining ?? 0 })),
);

await server.connect(new StdioServerTransport());
