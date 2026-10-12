// On-chain side of gib-escrow: find a Gibwork bounty's escrow on Solana, read its vault and its money flows.
//
// Layout of the escrow state account (owner ESCROW_PROGRAM, 99 bytes), read from mainnet:
//   0..8   Anchor discriminator
//   8..40  maker   (the wallet that funded the bounty)
//   40..72 mint    (reward token, e.g. USDC)
//   72..88 task id (the Gibwork task UUID, 16 raw bytes)
//   88..91 bumps
//   91..99 created-at, i64 little-endian unix seconds
// PDAs: state = ["escrow", maker, taskUuid], vault = ["vault", state] (an SPL token account).
import { Connection, PublicKey } from '@solana/web3.js';

export const ESCROW_PROGRAM = new PublicKey('BzYr7tV2ycbQU5bXc5LGpVTfQsbs7jUcrd1DhW4ma65y');
export const STATE_SIZE = 99;
export const DISCRIMINATOR = '1fd57bbbba16da9b';
export const TASK_ID_OFFSET = 72;
export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
// Owner of the token account that receives Gibwork's cut of every approval (seen on mainnet payouts, 5%).
export const PLATFORM_FEE_OWNERS = new Set(['workoNf4JwM97Brxo6NzR65oWkJAvARdYqW3RxttyCD']);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepts a task UUID or any gib.work URL containing one. */
export function parseTaskId(input) {
  const m = String(input).match(UUID_RE);
  if (!m) throw new Error(`no Gibwork task id (UUID) in "${input}"`);
  return m[0].toLowerCase();
}

export function uuidBytes(taskId) {
  return Buffer.from(parseTaskId(taskId).replace(/-/g, ''), 'hex');
}

export function bytesToUuid(b) {
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function deriveState(maker, taskId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), new PublicKey(maker).toBuffer(), uuidBytes(taskId)], ESCROW_PROGRAM)[0];
}

export function deriveVault(state) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(state).toBuffer()], ESCROW_PROGRAM)[0];
}

export function decodeState(data) {
  const d = Buffer.from(data);
  if (d.length !== STATE_SIZE || d.subarray(0, 8).toString('hex') !== DISCRIMINATOR)
    throw new Error('not a Gibwork escrow state account');
  return {
    maker: new PublicKey(d.subarray(8, 40)).toBase58(),
    mint: new PublicKey(d.subarray(40, 72)).toBase58(),
    taskId: bytesToUuid(d.subarray(72, 88)),
    createdAt: new Date(Number(d.readBigInt64LE(91)) * 1000).toISOString(),
  };
}

export function connect(rpc = process.env.GIB_ESCROW_RPC || DEFAULT_RPC) {
  return new Connection(rpc, 'confirmed');
}

/** All live (not yet closed) escrow states. */
export async function listEscrows(conn) {
  const accts = await conn.getProgramAccounts(ESCROW_PROGRAM, { filters: [{ dataSize: STATE_SIZE }] });
  return accts.map(a => ({ state: a.pubkey.toBase58(), ...decodeState(a.account.data) }));
}

/** The live escrow for one task, or null (never funded on this program, or already closed). */
export async function findEscrow(conn, taskId, maker) {
  if (maker) {
    const state = deriveState(maker, taskId);
    const info = await conn.getAccountInfo(state);
    return info ? { state: state.toBase58(), ...decodeState(info.data) } : { state: state.toBase58(), maker, taskId: parseTaskId(taskId), closed: true };
  }
  const accts = await conn.getProgramAccounts(ESCROW_PROGRAM, {
    filters: [{ dataSize: STATE_SIZE }, { memcmp: { offset: TASK_ID_OFFSET, bytes: bs58(uuidBytes(taskId)) } }],
  });
  if (!accts.length) return null;
  const a = accts[0];
  return { state: a.pubkey.toBase58(), ...decodeState(a.account.data) };
}

/** SPL token balances (base units, as strings) for many vaults in one RPC call; null where the vault is closed. */
export async function vaultBalances(conn, vaults) {
  const out = [];
  for (let i = 0; i < vaults.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(vaults.slice(i, i + 100).map(v => new PublicKey(v)));
    // SPL token account: mint 0..32, owner 32..64, amount u64 LE at 64.
    for (const info of infos) out.push(info && info.data.length >= 72 ? info.data.readBigUInt64LE(64).toString() : null);
  }
  return out;
}

export async function vaultBalance(conn, vault) {
  return (await vaultBalances(conn, [vault]))[0];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !/429|rate limit/i.test(String(e.message))) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}

/**
 * Every token movement in or out of the vault, oldest first.
 * kind: deposit (into the vault), refund (back to the maker), fee (Gibwork's cut), payout (the largest other
 * transfer in a transaction: the worker), referral (any further transfer in the same transaction).
 */
export async function vaultFlows(conn, vault, maker, { maxTx = 60, onProgress } = {}) {
  const v = new PublicKey(vault).toBase58();
  const sigs = [];
  let before;
  while (sigs.length < maxTx) {
    const page = await conn.getSignaturesForAddress(new PublicKey(vault), { before, limit: Math.min(1000, maxTx - sigs.length) });
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  const flows = [];
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    await sleep(Number(process.env.GIB_ESCROW_PACE_MS ?? 400)); // public RPC allows only a few calls per second
    const tx = await withRetry(() => conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    onProgress?.(flows.length, sigs.length);
    if (!tx) continue;
    const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    const owners = {};
    for (const tb of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])])
      owners[keys[tb.accountIndex]] = tb.owner;
    const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap(g => g.instructions)];
    for (const ix of ixs) {
      const p = ix.parsed;
      if (!p || !['transfer', 'transferChecked'].includes(p.type)) continue;
      const { source, destination } = p.info;
      if (source !== v && destination !== v) continue;
      const amount = p.info.tokenAmount ? p.info.tokenAmount.amount : p.info.amount;
      const counterparty = source === v ? destination : source;
      const cpOwner = owners[counterparty] || null;
      const kind = destination === v ? 'deposit' : (cpOwner === maker ? 'refund' : 'payout');
      flows.push({ kind, amount: String(amount), counterparty, counterpartyOwner: cpOwner, signature: s.signature,
        time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null });
    }
  }
  const labelled = labelPayouts(flows);
  labelled.truncated = sigs.length >= maxTx; // older transactions (often the deposit) were not read
  labelled.txRead = sigs.length;
  return labelled;
}

export function labelPayouts(flows) {
  const bySig = new Map();
  for (const f of flows) {
    if (f.kind !== 'payout') continue;
    if (PLATFORM_FEE_OWNERS.has(f.counterpartyOwner)) { f.kind = 'fee'; continue; }
    (bySig.get(f.signature) || bySig.set(f.signature, []).get(f.signature)).push(f);
  }
  for (const group of bySig.values()) {
    group.sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
    for (const f of group.slice(1)) f.kind = 'referral';
  }
  return flows;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function bs58(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte !== 0) break; s = '1' + s; }
  return s;
}
