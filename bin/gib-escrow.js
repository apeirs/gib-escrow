#!/usr/bin/env node
// gib-escrow: is this Gibwork bounty really funded, and has it paid anyone?
import { checkTask, scan, stranded, fmt } from '../src/report.js';
import { refundTask } from '../src/gibwork.js';

const HELP = `gib-escrow: check a Gibwork bounty's on-chain escrow before you work on it

Usage:
  gib-escrow check <task-id|gib.work URL> [--history] [--maker <pubkey>] [--json]
  gib-escrow scan [--min <amount>] [--json]
  gib-escrow stranded [--min <amount>] [--json]
  gib-escrow refund <task-id> --yes

  check     escrow address, what is left in it, verdict (FUNDED / LOW / NO_ESCROW) and notes
            --history   also list every deposit, payout and refund from the vault's transactions
            --max-tx    read at most this many vault transactions, newest first (default 60)
            --maker     creator wallet; finds the escrow even after it was closed
  scan      every live Gibwork escrow, joined with the open-bounty feed, ranked by money left per submission
            --min       hide escrows holding less than this (in token units)
  stranded  escrows still holding money for bounties that left the open feed (ended or closed)
  refund    creator only: return what is left in your bounty's escrow (Gibwork SDK tasks.refund)

Environment:
  SOLANA_PRIVATE_KEY   any Solana key; lets the Gibwork SDK read task details (free, read-only here)
  GIB_ESCROW_RPC       Solana RPC URL (default: public mainnet RPC)
`;

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const json = !!flag('--json');
const history = !!flag('--history');
const maker = flag('--maker');
const min = flag('--min');
const maxTx = flag('--max-tx');
const [cmd, target] = args;

try {
  if (cmd === 'check' && target) {
    const r = await checkTask(target, { history, maker: typeof maker === 'string' ? maker : undefined, maxTx: maxTx ? Number(maxTx) : undefined });
    if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
    const t = r.task, e = r.escrow;
    console.log(`${t?.title ?? r.taskId}\n${t?.url ?? ''}`);
    console.log(`verdict     ${r.verdict}`);
    if (t) console.log(`listing     ${fmt(Number(t.advertised) / 10 ** (t.decimals ?? 6))} ${t.symbol} pool, min payout ${t.minPayout ?? '?'}, ${t.pending} pending / ${t.approved} approved / ${t.rejected} rejected, deadline ${t.deadline ?? 'none'}`);
    if (e) {
      console.log(`escrow      ${e.state}${e.live ? '' : ' (closed)'}`);
      console.log(`vault       ${e.vault}`);
      console.log(`maker       ${e.maker}`);
      if (e.live) console.log(`remaining   ${fmt(e.remaining)} ${e.symbol}   (funded ${e.createdAt?.slice(0, 10)})`);
      if (e.history) {
        const h = e.history;
        console.log(`history     ${h.truncated ? `newest ${h.txRead} transactions only (raise --max-tx for all): ` : ''}${h.flows.length} transfers: deposited ${fmt(h.deposited)}, paid ${fmt(h.paidOut)} to ${h.recipients} worker wallet(s) in ${h.payouts} payout(s), fees ${fmt(h.fees)}, referrals ${fmt(h.referrals)}, refunded ${fmt(h.refunded)}`);
        for (const f of h.flows) console.log(`  ${f.time?.slice(0, 16).replace('T', ' ')}  ${f.kind.padEnd(7)} ${fmt(Number(f.amount) / 10 ** e.decimals).padStart(8)}  ${f.counterpartyOwner ?? f.counterparty}  ${f.signature.slice(0, 16)}…`);
      }
    }
    for (const n of r.notes) console.log(`note        ${n}`);
  } else if (cmd === 'scan') {
    const r = await scan({ minRemaining: min ? Number(min) : 0 });
    if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
    console.log(`${r.escrows} live escrows on chain, ${r.listed} bounties on the open feed\n`);
    console.log('left'.padStart(10) + '  ' + 'listed'.padStart(8) + '  subs  left/sub  title');
    for (const x of r.rows) {
      console.log(`${(fmt(x.remaining) + ' ' + x.symbol).padStart(10)}  ${(x.advertised == null ? '-' : fmt(x.advertised)).padStart(8)}  ${String(x.submissions ?? '-').padStart(4)}  ${(x.perSubmission == null ? '-' : fmt(x.perSubmission)).padStart(8)}  ${(x.title ?? '(not on the open feed) ' + x.taskId).slice(0, 60)}${x.permanentDelegate ? '  [!]' : ''}`);
    }
    if (r.rows.some(x => x.permanentDelegate)) console.log('\n[!] reward token has a Token-2022 permanent delegate: the issuer can move it out of the escrow at any time');
    if (r.unbacked.length) {
      console.log(`\n${r.unbacked.length} open bounties with no live escrow on the Gibwork escrow program (paid out, refunded, or paid another way):`);
      for (const u of r.unbacked) console.log(`  ${u.taskId}  ${u.title.slice(0, 70)}`);
    }
  } else if (cmd === 'stranded') {
    const rows = await stranded({ minRemaining: min ? Number(min) : 0 });
    if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
    const ended = rows.filter(r => r.ended);
    const total = {};
    for (const r of ended) total[r.symbol] = (total[r.symbol] || 0) + r.remaining;
    console.log(`${ended.length} ended bounties still hold money in escrow: ${Object.entries(total).map(([k, v]) => `${fmt(v)} ${k}`).join(', ') || 'none'}\n`);
    for (const r of rows) {
      const state = r.ended ? 'ended ' : r.ended === false ? 'open  ' : '?     ';
      console.log(`${state} ${(fmt(r.remaining) + ' ' + r.symbol).padStart(10)}  ${(r.deadline ?? '').slice(0, 10).padEnd(10)}  ${(r.creator ?? '?').slice(0, 16).padEnd(16)}  ${(r.title ?? r.taskId).slice(0, 52)}`);
    }
  } else if (cmd === 'refund' && target) {
    if (!flag('--yes')) { console.log('refund sends a transaction signed by SOLANA_PRIVATE_KEY (must be the creator). Re-run with --yes.'); process.exit(1); }
    const r = await refundTask(target);
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(HELP);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`gib-escrow: ${e.message}`);
  process.exit(2);
}
