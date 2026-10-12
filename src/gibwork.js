// Gibwork SDK side: task metadata for the escrows we find on chain.
// The SDK's discovery endpoints are wallet-authenticated but free; give it any Solana key via SOLANA_PRIVATE_KEY.
// Without a key, gib-escrow still works from chain data alone.
import { createGibworkClient } from '@gibwork/sdk/node';

let client;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Retries Gibwork API calls on HTTP 429, honouring retryAfter (seconds or an HTTP date) when the API sends it. */
async function api(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (e?.status !== 429 || i >= tries) throw e;
      const ra = e.retryAfter, s = Number(ra);
      await sleep(Number.isFinite(s) ? s * 1000 : ra ? Math.max(1000, Date.parse(ra) - Date.now()) : 5000 * 2 ** i);
    }
  }
}
export function gibwork() {
  if (client !== undefined) return client;
  const key = process.env.SOLANA_PRIVATE_KEY;
  client = key ? createGibworkClient({ privateKey: key, production: process.env.GIBWORK_STAGE !== '1' }) : null;
  return client;
}

/** One task's details, or null when no SDK client is configured or the task is unknown. */
export async function taskInfo(taskId) {
  const g = gibwork();
  if (!g) return null;
  try {
    const t = await api(() => g.tasks.get(taskId));
    return {
      title: t.title,
      url: `https://gib.work/bounty/${t.id}`,
      isOpen: t.isOpen,
      status: t.status,
      deadline: t.deadline,
      symbol: t.asset?.symbol,
      decimals: t.asset?.decimals,
      advertised: t.asset ? String(t.asset.amount) : null,
      minPayout: t.minSubmissionAmount ?? null, // UI units on the details endpoint
      pending: t.taskSubmissionsPendingCount,
      approved: t.taskSubmissionsApprovedCount,
      rejected: t.taskSubmissionsRejectedCount,
      health: t.health?.label ?? null,
      hoursSinceCreatorAction: t.health?.metrics?.hoursSinceCreatorAction ?? null,
      refundTx: t.refundTransactionId ?? null,
      creator: t.user?.username ?? null,
    };
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/** Every open task on the discovery feed (paged, 100 per page). */
export async function availableTasks({ maxPages = 10 } = {}) {
  const g = gibwork();
  if (!g) return [];
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(() => g.tasks.listAvailable({ page, limit: 100 }));
    out.push(...r.results);
    if (page >= r.lastPage) break;
  }
  return out;
}

/** Creator-only: return what is left in your bounty's escrow to your wallet (SDK prepare, sign, submit). */
export async function refundTask(taskId) {
  const g = gibwork();
  if (!g) throw new Error('refund needs SOLANA_PRIVATE_KEY set to the wallet that created the bounty');
  return g.tasks.refund(taskId);
}
