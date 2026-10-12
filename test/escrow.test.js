// Offline tests. The fixture is the real escrow state of the Gibwork Developer Hackathon bounty,
// read from Solana mainnet (account CPoj222pQE9TTqd8DuXC4Q57dGKgRbXXX9EpTDGhmKfz).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeState, deriveState, deriveVault, parseTaskId, bs58, uuidBytes } from '../src/escrow.js';
import { verdict } from '../src/report.js';

const STATE_HEX = '1fd57bbbba16da9b02fa6de7d595649ffabb8951afc5a2e59e655559b6f5cae01713f77df78da7e9c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d611052f22d3f874b1db0d771a60679e7fafefffe6353a06a00000000';
const TASK = '1052f22d-3f87-4b1d-b0d7-71a60679e7fa';

test('decodes the escrow state account', () => {
  const s = decodeState(Buffer.from(STATE_HEX, 'hex'));
  assert.equal(s.maker, 'CdJBwL9X16QaSJgjVayX3xvGwEmYenrzSE4UqywX1BN');
  assert.equal(s.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(s.taskId, TASK);
  assert.equal(s.createdAt, '2026-09-08T18:26:43.000Z');
});

test('rejects accounts that are not escrow states', () => {
  assert.throws(() => decodeState(Buffer.alloc(99)));
  assert.throws(() => decodeState(Buffer.from(STATE_HEX.slice(0, 100), 'hex')));
});

test('derives the same state and vault PDAs as mainnet', () => {
  const state = deriveState('CdJBwL9X16QaSJgjVayX3xvGwEmYenrzSE4UqywX1BN', TASK);
  assert.equal(state.toBase58(), 'CPoj222pQE9TTqd8DuXC4Q57dGKgRbXXX9EpTDGhmKfz');
  assert.equal(deriveVault(state).toBase58(), '9Nw5KFDj2vZsBJnQiYpKxpr9K2P1UkJGooLX9MtPWaEd');
});

test('parses task ids from UUIDs and gib.work URLs', () => {
  assert.equal(parseTaskId(`https://gib.work/bounty/${TASK.toUpperCase()}?ref=x`), TASK);
  assert.throws(() => parseTaskId('https://gib.work/bounty/nope'));
});

test('base58 matches the known encoding of a public key', () => {
  const hex = '02fa6de7d595649ffabb8951afc5a2e59e655559b6f5cae01713f77df78da7e9';
  assert.equal(bs58(Buffer.from(hex, 'hex')), 'CdJBwL9X16QaSJgjVayX3xvGwEmYenrzSE4UqywX1BN');
  assert.equal(uuidBytes(TASK).length, 16);
});

test('verdicts', () => {
  assert.equal(verdict({ live: false, remaining: 0, minPayout: 5 }), 'NO_ESCROW');
  assert.equal(verdict({ live: true, remaining: 4, minPayout: 5 }), 'LOW');
  assert.equal(verdict({ live: true, remaining: 5, minPayout: 5 }), 'FUNDED');
  assert.equal(verdict({ live: true, remaining: 1, minPayout: null }), 'FUNDED');
});

test('labels the worker, fee and referral legs of one approval', async () => {
  const { labelPayouts } = await import('../src/escrow.js');
  const f = (amount, owner) => ({ kind: 'payout', amount, counterpartyOwner: owner, signature: 'sig1' });
  const flows = labelPayouts([f('50000', 'workoNf4JwM97Brxo6NzR65oWkJAvARdYqW3RxttyCD'), f('50000', 'Referrer'), f('900000', 'Worker')]);
  assert.deepEqual(flows.map(x => x.kind), ['fee', 'referral', 'payout']);
});
