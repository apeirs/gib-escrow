// Joins chain data with Gibwork task data and turns it into a verdict a bounty hunter (or an agent) can act on.
import { connect, listEscrows, findEscrow, deriveVault, vaultBalances, vaultFlows, parseTaskId } from './escrow.js';
import { taskInfo, availableTasks } from './gibwork.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SYMBOLS = { '29bHTjaAH8VCLbsSxeGKFr3YeoQWf6BkStTgnCJmGsRT': 'CREDITS' }; // Gibwork WORKCREDITS (Token-2022)
const KNOWN_MINTS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6, permanentDelegate: null },
};

async function mintMeta(conn, mint) {
  if (KNOWN_MINTS[mint]) return KNOWN_MINTS[mint];
  const { PublicKey } = await import('@solana/web3.js');
  const info = (await conn.getParsedAccountInfo(new PublicKey(mint))).value?.data?.parsed?.info ?? {};
  // Token-2022 permanent delegate: that key can move the token out of ANY account, escrow vaults included.
  const pd = (info.extensions || []).find(x => x.extension === 'permanentDelegate')?.state?.delegate ?? null;
  return (KNOWN_MINTS[mint] = { symbol: SYMBOLS[mint] ?? mint.slice(0, 4) + '…', decimals: info.decimals ?? 0, permanentDelegate: pd });
}

const ui = (base, decimals) => (base == null ? null : Number(BigInt(base)) / 10 ** decimals);

/**
 * Verdicts:
 *   FUNDED       live escrow holds at least one minimum payout
 *   LOW          live escrow holds less than one minimum payout (new entries are unlikely to be paid in full)
 *   NO_ESCROW    no live escrow for this task (paid out, refunded, or never funded on chain)
 */
export function verdict({ remaining, minPayout, live }) {
  if (!live) return 'NO_ESCROW';
  if (minPayout != null && remaining < minPayout) return 'LOW';
  return 'FUNDED';
}

export async function checkTask(input, { history = false, maker, maxTx } = {}) {
  const taskId = parseTaskId(input);
  const conn = connect();
  const [esc, task] = await Promise.all([findEscrow(conn, taskId, maker), taskInfo(taskId)]);
  const live = !!(esc && !esc.closed);
  const out = { taskId, task, escrow: null, verdict: null, notes: [] };
  if (esc) {
    const vault = deriveVault(esc.state).toBase58();
    const meta = esc.mint ? await mintMeta(conn, esc.mint) : { symbol: task?.symbol, decimals: task?.decimals ?? 6 };
    const [bal] = live ? await vaultBalances(conn, [vault]) : [null];
    out.escrow = { state: esc.state, vault, maker: esc.maker, mint: esc.mint ?? null, symbol: meta.symbol, decimals: meta.decimals,
      createdAt: esc.createdAt ?? null, remaining: ui(bal, meta.decimals), live, permanentDelegate: meta.permanentDelegate ?? null };
    if (meta.permanentDelegate) out.notes.push(`reward token has a permanent delegate (${meta.permanentDelegate}): that key can move it out of the escrow at any time, so this pool is not held trustlessly`);
    if (history) {
      const flows = await vaultFlows(conn, vault, esc.maker, { maxTx, onProgress: (_, n) => process.stderr.isTTY && process.stderr.write('.') });
      if (flows.length && process.stderr.isTTY) process.stderr.write('\n');
      const sum = k => flows.filter(f => f.kind === k).reduce((a, f) => a + ui(f.amount, meta.decimals), 0);
      out.escrow.history = { deposited: sum('deposit'), paidOut: sum('payout'), fees: sum('fee'), referrals: sum('referral'), refunded: sum('refund'), truncated: !!flows.truncated, txRead: flows.txRead,
        payouts: flows.filter(f => f.kind === 'payout').length,
        recipients: [...new Set(flows.filter(f => f.kind === 'payout').map(f => f.counterpartyOwner))].length, flows };
    }
  }
  const remaining = out.escrow?.remaining ?? 0;
  out.verdict = verdict({ remaining, minPayout: task?.minPayout ?? null, live });
  if (task) {
    const adv = ui(task.advertised, task.decimals ?? 6);
    if (live && adv != null && remaining < adv) out.notes.push(`escrow holds ${fmt(remaining)} of the ${fmt(adv)} ${task.symbol} the listing shows (the API reports the original pool, not what is left)`);
    if (task.minPayout && live) out.notes.push(`room for ${Math.floor(remaining / task.minPayout)} more minimum payout(s) of ${fmt(task.minPayout)} vs ${task.pending} pending submission(s)`);
    if (!live && task.isOpen) out.notes.push('listed as open, but no live escrow was found: check before paying a submission fee');
    if (task.hoursSinceCreatorAction != null && task.hoursSinceCreatorAction > 24 * 14)
      out.notes.push(`creator inactive for ${Math.round(task.hoursSinceCreatorAction / 24)} days (Gibwork health: ${task.health})`);
  } else {
    out.notes.push('no task metadata (set SOLANA_PRIVATE_KEY to let the Gibwork SDK fetch it)');
  }
  return out;
}

/** Every live escrow, joined with the discovery feed, ranked by money left per pending submission. */
export async function scan({ minRemaining = 0 } = {}) {
  const conn = connect();
  const escrows = await listEscrows(conn);
  const bals = await vaultBalances(conn, escrows.map(e => deriveVault(e.state).toBase58()));
  const feed = await availableTasks();
  const byId = new Map(feed.map(t => [t.id, t]));
  const rows = [];
  for (const [i, e] of escrows.entries()) {
    const meta = await mintMeta(conn, e.mint);
    const t = byId.get(e.taskId);
    const remaining = ui(bals[i], meta.decimals) ?? 0;
    if (remaining < minRemaining) continue;
    const advertised = t?.asset ? ui(t.asset.amount, t.asset.decimals) : null;
    rows.push({ taskId: e.taskId, title: t?.title ?? null, listed: !!t, symbol: t?.asset?.symbol || meta.symbol, mint: e.mint, permanentDelegate: meta.permanentDelegate ?? null, remaining, advertised,
      submissions: t?.totalSubmissions ?? null, perSubmission: t ? remaining / ((t.totalSubmissions ?? 0) + 1) : null,
      deadline: t?.deadline ?? null, createdAt: e.createdAt, url: `https://gib.work/bounty/${e.taskId}` });
  }
  rows.sort((a, b) => (b.perSubmission ?? -1) - (a.perSubmission ?? -1) || b.remaining - a.remaining);
  const escrowIds = new Set(escrows.map(e => e.taskId));
  const unbacked = feed.filter(t => !escrowIds.has(t.id)).map(t => ({ taskId: t.id, title: t.title, url: `https://gib.work/bounty/${t.id}` }));
  return { escrows: escrows.length, listed: feed.length, rows, unbacked };
}

/**
 * Escrows still holding money for bounties that are no longer on the open feed.
 * ended = past deadline or closed on Gibwork; the creator can refund what is left (gib-escrow refund).
 */
export async function stranded({ minRemaining = 0 } = {}) {
  const { rows } = await scan({ minRemaining });
  const out = [];
  for (const r of rows.filter(x => !x.listed)) {
    await sleep(Number(process.env.GIB_ESCROW_API_PACE_MS ?? 1200));
    const t = await taskInfo(r.taskId).catch(() => null);
    const ended = t ? (!t.isOpen || (t.deadline && Date.parse(t.deadline) < Date.now())) : null;
    out.push({ ...r, title: t?.title ?? null, creator: t?.creator ?? null, deadline: t?.deadline ?? null,
      isOpen: t?.isOpen ?? null, ended, pending: t?.pending ?? null, approved: t?.approved ?? null });
  }
  return out;
}

export function fmt(n) {
  if (n == null) return '?';
  if (n === 0) return '0';
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2);
}
