# Parallel-nonce transaction submission on Sei

Fire many transactions from **one funded account** in rapid succession, where a
failure or a drop strands nothing behind it.

Built on EIP-7702 plus ERC-4337 v0.8, running against the EntryPoint already
deployed on Sei at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.

## The problem

A single account's EVM nonces are strictly sequential. That is a consensus rule,
not an RPC quirk, and two different things get blamed on it:

| | Blocks later transactions? |
| --- | --- |
| Transaction lands and reverts (slippage, bad price) | No. It consumes its nonce and the next one proceeds. |
| Transaction never lands (dropped, underpriced, rejected, lost before submit) | **Yes.** Every later nonce is stranded until you replace it. |

Only the second case is the real constraint, and Sei makes it sharper than
Ethereum in two ways:

- Under Autobahn, the producer mempool admits EVM transactions in strict
  per-sender nonce order. A gap is rejected with `bad nonce` rather than queued.
- `eth_getTransactionCount(addr, "pending")` returns the same value as
  `"latest"`, so there is no pending-nonce view to reconcile against.

The usual workaround is a fleet of funded hot wallets, which fragments balances
and multiplies the security surface.

## The mechanism

ERC-4337 does not use the account's EVM nonce. The EntryPoint stores its own:

```
nonce = (uint192 key << 64) | uint64 sequence
```

One `sequence` counter per `key`. Ops on different keys are mutually
independent: neither can strand the other, in any order, whether the other
lands, reverts, or is never submitted at all. A fresh key starts at sequence 0
and can appear at any time.

EIP-7702 is what lets the **existing** funded address use this. One
authorization points the EOA at an implementation contract, and from then on the
same address, holding the same balance and the same venue approvals, can be
driven by the EntryPoint. The EOA's own nonce is spent once, at delegation, and
then left alone.

So: **7702 keeps the address, 4337 supplies the nonce model.** 7702 alone does
not help here. Its own transactions are still sequential, and the spec advises
clients to accept only one pending transaction from a delegated EOA, which makes
concurrency worse rather than better.

## What is here

```
src/LaneAccount.sol        EIP-7702 implementation. Simple7702Account + "key 0 is rejected".
src/MockPerpVenue.sol      Stand-in venue that reverts on slippage, so failure is observable.
test/ParallelNonce.t.sol   12 tests proving the isolation property against real EntryPoint code.
script/Deploy.s.sol        Deploys the implementation and the venue.
app/src/lanes.ts           Lane pool: local sequence tracking, one in-flight op per lane.
app/src/mempool.ts         Private alt-mempool.
app/src/relayers.ts        Pool of gas-only submitters.
app/src/spray.ts           Fires N independent orders and reports what happened.
app/src/baseline.ts        Demonstrates the sequential constraint for contrast.
```

## Quick start: prove it locally

No funds, no testnet, about thirty seconds.

```bash
forge test -vv
```

```
[PASS] test_uniqueLanes_landInAnyOrder()            8 lanes submitted in reverse, all land
[PASS] test_revertingOp_doesNotBlockOtherLanes()    a revert consumes only its own lane
[PASS] test_droppedOp_doesNotBlockOtherLanes()      an op that never lands strands nothing
[PASS] test_retryAfterFailure_usesNextSeq()         a failed op still burns its sequence
[PASS] test_sameLane_droppedOpStrandsSuccessor()    the old behaviour, reproduced on one lane
[PASS] test_sameLane_gapRevertsWholeBundle()        why one lane per in-flight op
[PASS] test_validationFailure_killsWholeBundle()    bundles share a validation failure domain
[PASS] test_fiftyLanes_oneBundle()                  50 ops, one bundle, ~155k gas per op
...
12 passed
```

`test_droppedOp_doesNotBlockOtherLanes` is the one that matters for the stated
problem. It builds three ops, deliberately never submits the middle one,
confirms the other two land anyway, then submits the dropped one afterwards and
watches it land *behind* its own successors. No replacement transaction, no
re-signing, no stuck queue.

## Run it end to end

### Option A: against a fork (no funds needed)

```bash
anvil --fork-url https://evm-rpc-testnet.sei-apis.com --hardfork prague
```

The fork carries the real EntryPoint v0.8 bytecode, so this is not a mock.

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --broadcast --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

Copy the printed `LANE_ACCOUNT_IMPL` and `VENUE` into `.env`, then:

```bash
cd app && npm install
npm run status     # preflight: delegation, deposits, lane sequences
npm run delegate   # one-time EIP-7702 authorization
npm run fund       # top up relayers, pre-deposit gas into the EntryPoint
npm run spray      # fire the orders
```

### Option B: against Atlantic-2

Same commands with `SEI_RPC_URL=https://evm-rpc-testnet.sei-apis.com`. Fund the
trading key from the [Sei faucet](https://docs.sei.io/learn/faucet), and generate
**fresh** relayer keys with `cast wallet new-mnemonic`.

> Do not reuse well-known test mnemonics on a live chain. On Atlantic-2 those
> addresses are already 7702-delegated to a sweeper contract that forwards any
> incoming value to a third party. This project hit exactly that during
> development: a funding transfer succeeded with status 1 and the balance was
> still zero, because the delegated code swept it in the same call.

## What a run looks like

```
=== submit ===
24 ops -> bundles of <=4 -> 4 relayers

  mined   lanes [32,31,30,29]  block 268855037  gas 537856
  mined   lanes [20,19,18,17]  block 268855037  gas 606281
  ...

  #  lane  seq  exec      filled  land#  block     note
   0    32    0  ok           yes       1  268855037
   1    31    0  ok           yes       2  268855037
   2    30    0  reverted     no        0  268855037  sabotaged (limit under mark)
   3    29    0  ok           yes       3  268855037
   ...

=== summary ===
ops submitted        24
ops landed           24
  executed ok        23
  reverted on chain  1  (each consumed only its own lane)
distinct lanes       24
relayers used        4

trader EVM nonce     89 -> 89  UNCHANGED
```

Order 2 was given an unfillable limit price. It reverted on chain and the
twenty-three orders around it landed regardless, including the ones submitted
after it. The trading account's EVM nonce never moved.

Run `npm run baseline` for the contrast: a single account sending nonce `n+1`
while `n` is missing, which sits unincludable until the gap is filled.

## How it fits together

```
                signs intents, never sends transactions
  trading EOA  ────────────────────────────────────────┐
  (7702 → LaneAccount, holds all inventory)            │
                                                       ▼
                                            private mempool (in-process)
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                          relayer 0                relayer 1                relayer N
                        (gas only)               (gas only)               (gas only)
                              │                        │                        │
                              └────────── EntryPoint.handleOps ─────────────────┘
```

The sequential-nonce constraint does not vanish, it **moves**. Each relayer still
burns a strictly sequential EVM nonce with one transaction in flight. What
changes is that relayers hold nothing: losing one costs gas, not inventory, and
the trading account is never in a queue.

Throughput is roughly `relayers x opsPerBundle` per block. Sei blocks are about
400ms, so widening either dimension scales it directly.

### Why run a private mempool

Two limits make the canonical ERC-4337 mempool unusable at this rate:

- ERC-7562 caps an unstaked sender at **4** pending UserOperations
  (`SAME_SENDER_MEMPOOL_COUNT`). That is a wallet number, not a trading number.
- The ERC-7562 validation rules exist so competing bundlers can safely pack
  strangers' operations. Every op here comes from one account we control.

Nothing that protects funds is bypassed. The EntryPoint still enforces the
signature over the EIP-712 op hash, per-lane nonce uniqueness, and prefund
solvency.

## Operational notes

**One in-flight op per lane.** Ops sharing a lane are ordered, and a missing
sequence strands the rest of that lane. `LanePool` enforces this by not reissuing
a lane until the previous op resolves, which makes the pool size the ceiling on
in-flight operations.

**A failed op still consumes its sequence.** Anything that lands, successful or
reverted, advances its lane. A retry uses `seq + 1`, not `seq`. Only ops in a
bundle that never mined consume nothing. `LanePool.settle(lane, consumed)`
encodes exactly this, with `consumed` tied to whether `handleOps` mined.

**Bundles are a shared failure domain for validation errors.** An execution
revert is isolated (proven in the tests). A *validation* failure (bad signature,
stale nonce, thin prefund) reverts the whole `handleOps` call, including
healthy ops beside it. That is the one place batching reintroduces coupling.
`MAX_OPS_PER_BUNDLE=1` gives maximum isolation; higher values amortize the base
transaction cost. Every bundle is simulated before it is sent.

**Lane 0 is rejected.** Key 0 is what every SDK picks when no key is passed, and
a book that lands entirely on key 0 is one queue again. `LaneAccount` turns that
silent fallback into a loud validation failure. Ordered admin work uses
`ADMIN_LANE` instead.

**No nonce reads on the hot path.** Lane sequences are read once at startup and
tracked locally, so signing 24 ops costs zero RPC round-trips. This matters on
Sei specifically, where pending-nonce queries return the confirmed value.

**Independent nonces are not independent execution.** Two ops that touch the same
storage still serialize inside the block, whatever their nonces look like. That
is why `MockPerpVenue` writes each order to its own slot. Nonce lanes remove the
*submission* bottleneck; disjoint state is what buys parallel *execution*. A
fleet of hot wallets sharing one margin account has the same limit, and pays for
it with fragmented inventory.

**tx.origin.** After delegation, `tx.origin` is the relayer while `msg.sender` at
the venue is the trading EOA. Routers are fine. A few older
`require(tx.origin == msg.sender)` guards are not. Audit the venues you call.

## Versions

Foundry 1.8.1, Solidity 0.8.28, account-abstraction v0.8.0, OpenZeppelin v5.1.0,
viem 2.56, Node 26.
