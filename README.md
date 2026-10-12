# gib-escrow

**Is this Gibwork bounty really funded, and has it paid anyone?**

`gib-escrow` is a terminal tool and an MCP server that finds a Gibwork bounty's escrow on Solana and tells you
what is actually left in it, who it has paid, and whether the pool can still pay the people already queued for it.
It joins that chain data with task data from the Gibwork SDK.

Built for the Gibwork Developer Hackathon. Toolset: **Gibwork SDK** (`@gibwork/sdk`: `tasks.get`,
`tasks.listAvailable`, `tasks.refund`) plus direct Solana RPC reads. It ships as a **CLI** (`gib-escrow`) and an
**MCP server** (`gib-escrow-mcp`) for AI agents.

## Why

The SDK's own docs say it: on the discovery feed, `asset.amount` is *"the original reward pool, not remaining
funds"*. Submitting work costs a fee (0.15 USDC today). So a hunter, human or agent, can't tell from the API
whether a bounty still has money for them. Run against mainnet on 2026-10-12, gib-escrow found:

- A bounty listed with a **100 USDC** pool whose escrow held **25 USDC**, with **150 submissions pending**. That's room
  for 25 more minimum payouts.
- **26 bounties that had ended** but still held **260 USDC + 120 CREDITS** in escrow. Their creators can refund that
  money, and `gib-escrow refund` does it through the SDK.
- Two pools paid in **WORKCREDITS**, a Token-2022 token with a *permanent delegate*. The token issuer can move
  it out of the escrow at any time, so those pools are not held trustlessly. Worth knowing before you work for one.

## How it finds the escrow

Gibwork bounties are escrowed by program `BzYr7tV2ycbQU5bXc5LGpVTfQsbs7jUcrd1DhW4ma65y`. The details below were
reverse-engineered from mainnet and pinned by the tests:

| account | derivation / layout |
|---|---|
| escrow state (99 bytes) | PDA `["escrow", maker, taskUuid(16 bytes)]`; data = discriminator, maker, mint, **task UUID at offset 72**, bumps, created-at (i64 LE) |
| vault (SPL / Token-2022 account) | PDA `["vault", escrowState]` |

So a task ID becomes an escrow with one `getProgramAccounts` memcmp on offset 72, and the vault's transaction
history shows every deposit, payout and refund. Each approval pays three legs, which the tool labels:
worker (≈90%), Gibwork fee (5%, to `workoNf4…`), and referral (5%).

## Setup

Node.js 22 or newer.

```bash
git clone https://github.com/apeirs/gib-escrow && cd gib-escrow
npm install
npm link            # optional: puts gib-escrow and gib-escrow-mcp on your PATH
```

| variable | needed for | notes |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | task titles, pools and counts from the Gibwork SDK | Any Solana key works; reads are free. Base58 or a JSON byte array, as the SDK accepts. Without it you still get the chain data. Only `refund` signs anything, and only with the creator's key. |
| `GIB_ESCROW_RPC` | optional | Solana RPC URL. Default: public mainnet RPC (rate-limited; `--history` is paced to fit it). |

```bash
export SOLANA_PRIVATE_KEY="$(cat ~/.config/solana/id.json)"
```

## Usage

```bash
gib-escrow check <task-id | gib.work URL> [--history] [--max-tx N] [--maker <pubkey>] [--json]
gib-escrow scan [--min <amount>] [--json]
gib-escrow stranded [--min <amount>] [--json]
gib-escrow refund <task-id> --yes        # creator only
```

| command | what it answers |
|---|---|
| `check` | Verdict **FUNDED** / **LOW** (less than one minimum payout left) / **NO_ESCROW**, escrow and vault addresses, what is left, plus notes: listing vs. reality, payouts still possible vs. submissions pending, creator inactivity, permanent-delegate tokens. `--history` lists every deposit, payout, fee, referral and refund. |
| `scan` | Every live escrow next to the open-bounty feed, ranked by money left per submission. This is the "where is my time best spent" view. |
| `stranded` | Ended bounties that still hold money in escrow. |
| `refund` | Calls the SDK's `tasks.refund` for your own bounty. |

### Sample output (real runs, 2026-10-12)

```text
$ gib-escrow check 719f5bac-1fdb-4cec-b1ea-53cef65c76f4 --history --max-tx 6
What Would You Tell a Friend About BASIS? Pick ONE angle
https://gib.work/bounty/719f5bac-1fdb-4cec-b1ea-53cef65c76f4
verdict     FUNDED
listing     100 USDC pool, min payout 1, 150 pending / 75 approved / 7 rejected, deadline 2026-10-26T04:44:32.737Z
escrow      AWZR6RtAA5WFVjS2MEpzJWGJXymJeo968HVx3RhFQxxo
vault       7Gfmca8wJFsDKgQHANAQA8SAGTvYN1VbeqGBSnc9etUM
remaining   25.00 USDC   (funded 2026-10-12)
history     newest 6 transactions only (raise --max-tx for all): 17 transfers: deposited 0, paid 5.22 to 6 worker wallet(s) in 6 payout(s), fees 0.53, referrals 0.25, refunded 0
  2026-10-12 08:02  fee         0.28  workoNf4JwM97Brxo6NzR65oWkJAvARdYqW3RxttyCD  rTu59aNmMDoA7SZz…
  2026-10-12 08:02  payout      0.72  FVm7PL9BaBfNZgb2V3So7Ubcq7i4ENE8u48wr1Kvo9S2  rTu59aNmMDoA7SZz…
  ...
note        escrow holds 25.00 of the 100 USDC the listing shows (the API reports the original pool, not what is left)
note        room for 25 more minimum payout(s) of 1.00 vs 150 pending submission(s)
```

```text
$ gib-escrow scan --min 1
48 live escrows on chain, 8 bounties on the open feed

      left    listed  subs  left/sub  title
 1000 USDC      1000    11     83.33  Gibwork Developer Hackathon Bounty
  300 USDC       300    45      6.52  Create a UGC Video Bounty for the Gibwork Mobile App
200 CREDITS       200    45      4.35  Create an X Thread About the Gibwork Mobile App Bounty  [!]
 ...
25.00 USDC       100   232      0.11  What Would You Tell a Friend About BASIS? Pick ONE angle
```

Full outputs are in [`examples/`](examples/).

## MCP server (for agents)

```json
{
  "mcpServers": {
    "gib-escrow": {
      "command": "npx",
      "args": ["-y", "-p", "github:apeirs/gib-escrow", "gib-escrow-mcp"],
      "env": { "SOLANA_PRIVATE_KEY": "<any Solana key>" }
    }
  }
}
```

Or point `command` at `node /path/to/gib-escrow/bin/gib-escrow-mcp.js`. Tools:

- `check_bounty_funding { task, history?, maker? }`: call it before an agent pays a submission fee.
- `scan_funded_bounties { min_remaining? }`
- `list_stranded_escrows { min_remaining? }`

This pairs with the official `@gibwork/mcp`: that server lets an agent create bounties and submit work, and
gib-escrow lets it decide which bounties are worth the fee.

## Tests

```bash
npm test
```

The tests run offline against a fixture: the real escrow state of the hackathon bounty. They pin the account
layout, both PDA derivations, task-ID parsing, the verdict rules and the payout-leg labelling.

## Limits

- Only the escrow program above is covered. A bounty paid some other way shows `NO_ESCROW`; read that as "not
  in this escrow", not as "unfunded".
- Escrows that were closed (fully paid or refunded) can't be found by task ID alone. Pass `--maker` to derive them.
- The public RPC is rate-limited. For long histories use your own RPC (`GIB_ESCROW_RPC`) or raise `GIB_ESCROW_PACE_MS`.
- Labels for fee and referral legs come from observed mainnet payouts, not from a published spec.

MIT licensed.
