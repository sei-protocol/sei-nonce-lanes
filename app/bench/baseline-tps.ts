import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { venueAbi } from '../src/abi.js';
import { readDecimal, readInteger, readMnemonic, type EnvSource } from '../src/config.js';
import {
  assertWriteNetwork,
  chain,
  displayRpcUrl,
  explorerTx,
  publicClient,
  receiptPollingIntervalMs,
  relayerAccounts,
  rpcUrl,
  trader,
  venueAddress,
} from '../src/env.js';

/**
 * Throughput of the thing nonce lanes replace: one EOA sending ordinary
 * transactions with strictly sequential EVM nonces, against the same
 * `MockPerpVenue.place` call the lane path uses.
 *
 * Every nonce comes from ONE confirmed read (`latest`) at the start of a phase,
 * and every transaction is signed offline before the first broadcast. Sei's
 * producer mempool (Autobahn) admits a sender's transactions only in nonce order
 * and answers a gap with `bad nonce` instead of queuing behind it, and it has no
 * reliable `pending` view. A nonce taken from `pending`, or re-read per
 * transaction while earlier ones are in flight, can therefore be wrong in either
 * direction, and one wrong number poisons every transaction signed after it.
 * `pending` is still sampled, for the report only.
 *
 * Modes: serial (send, wait, repeat), pipelined (all N in nonce order, no
 * waiting), pipelined-gap (one transaction lost before broadcast, then recover),
 * batch (all N in one JSON-RPC batch), fleet (many hot wallets, each pipelined).
 * Each mode prints a summary and appends one JSON line to BENCH_RESULTS_PATH.
 */

type BenchMode = 'serial' | 'pipelined' | 'pipelined-gap' | 'batch' | 'fleet';
const ALL_MODES: readonly BenchMode[] = ['serial', 'pipelined', 'pipelined-gap', 'batch', 'fleet'];

/** Receipt lookups in flight at once after a phase has landed. */
const RECEIPT_CONCURRENCY = 8;
const TRANSFER_GAS = 21_000n;
const QTY = 10n ** 18n;

type Settings = {
  mode: BenchMode | 'all';
  txs: number;
  sender: 'trader' | 'bench';
  walletStartIndex: number;
  fleetSize: number;
  fundTarget: bigint;
  gapIndex: number;
  concurrency: number;
  receiptDeadlineMs: number;
  resultsPath: string;
  label: string | undefined;
};

type Sender = {
  account: LocalAccount;
  /** Slot in the orderId space: 0 for the trader, the derivation index for mnemonic wallets. */
  walletIndex: number;
  name: string;
};

type NonceSample = { latest: number; pending: number };

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

type ModeContext = {
  settings: Settings;
  venue: Address;
  markPx: bigint;
  blockGasLimit: bigint;
  /** Estimated once per mode, doubled like submit.ts, reused by every transaction in it. */
  fees: Fees;
};

type SignedTx = {
  index: number;
  nonce: number;
  orderId: bigint;
  hash: Hex;
  raw: Hex;
};

type Broadcast =
  | { kind: 'accepted'; tx: SignedTx; sentAt: number; doneAt: number }
  | { kind: 'rejected'; tx: SignedTx; error: string; sentAt: number; doneAt: number }
  | { kind: 'skipped'; tx: SignedTx };

type Prepared = {
  sender: Sender;
  nonceBefore: NonceSample;
  gas: bigint;
  txs: SignedTx[];
  signMs: number;
};

type Submission = {
  /** First broadcast of every index, in nonce order. */
  broadcasts: Broadcast[];
  /** Re-broadcasts made while recovering, in the order they were sent. */
  recovery: Broadcast[];
  submitStart: number;
  submitEnd: number;
};

type Landed = {
  tx: SignedTx;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  status: 'success' | 'reverted';
};

type Settled = {
  landEnd: number;
  deadlineHit: boolean;
  landed: Landed[];
  /** Accepted by the node, no receipt by the deadline. */
  missingNonces: number[];
  nonceAfter: NonceSample;
};

type SenderRun = Prepared & Submission & Settled;

type PendingRun = {
  prepared: Prepared;
  submission: Submission;
  /** Set when the mode already watched receipts itself (serial), so settleAll skips the nonce poll. */
  observed?: { landEnd: number; deadlineHit: boolean };
};

type WalletRecord = {
  name: string;
  walletIndex: number;
  address: Address;
  accepted: number;
  rejected: number;
  landed: number;
  reverted: number;
  missing: number;
  missingNonces: number[];
  submitMs: number;
  landMs: number;
  tpsClient: number;
  nonceBefore: NonceSample;
  nonceAfter: NonceSample;
};

type ModeRecord = {
  mode: BenchMode;
  label?: string;
  timestamp: string;
  chainId: number;
  senders: Address[];
  txsRequested: number;
  /** Distinct transactions the node accepted at least once. */
  accepted: number;
  /** Rejection responses, all passes. */
  rejected: number;
  /** Never broadcast: skipped gap index before recovery, or a serial loop that stopped. */
  skipped: number;
  rejectionsByMessage: Record<string, number>;
  landed: number;
  reverted: number;
  missing: number;
  missingNonces: number[];
  deadlineHit: boolean;
  submitMs: number;
  landMs: number;
  tpsClient: number;
  firstBlock: bigint | null;
  lastBlock: bigint | null;
  blockSpan: number;
  chainSpanSeconds: number;
  tpsChain: number;
  landedPerBlock: number;
  totalGasUsed: bigint;
  avgGasPerTx: bigint;
  gasLimitPerTx: bigint;
  costWei: bigint;
  costSei: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonceBefore?: NonceSample;
  nonceAfter?: NonceSample;
  blockGasLimit: bigint;
  signMs: number;
  concurrency?: number;
  gapIndex?: number;
  rejectedBehindGap?: number;
  admittedBehindGap?: number;
  recoveryRebroadcasts?: number;
  recoveryRejected?: number;
  recoveryMs?: number;
  fleetSize?: number;
  perWallet?: WalletRecord[];
};

type Extras = Partial<
  Pick<
    ModeRecord,
    | 'concurrency'
    | 'gapIndex'
    | 'rejectedBehindGap'
    | 'admittedBehindGap'
    | 'recoveryRebroadcasts'
    | 'recoveryRejected'
    | 'recoveryMs'
    | 'fleetSize'
    | 'perWallet'
  >
>;

/** Both clients used here expose this; the batch client is a different transport type. */
type Broadcaster = {
  sendRawTransaction: (args: { serializedTransaction: Hex }) => Promise<Hex>;
};

/* ------------------------------- settings -------------------------------- */

function readSettings(env: EnvSource): Settings {
  const txs = readInteger(env, 'BENCH_TXS', 50, { min: 1, max: 5_000 });
  // Indices 0..31 are the relayers' by convention; the address check in
  // assertUnreservedWallets is what actually enforces distinctness.
  const walletStartIndex = readInteger(env, 'BENCH_WALLET_START_INDEX', 100, {
    min: 32,
    max: 2_147_483_647 - 64,
  });
  return {
    mode: readMode(env),
    txs,
    sender: readSender(env),
    walletStartIndex,
    fleetSize: readInteger(env, 'BENCH_FLEET_SIZE', 4, { min: 0, max: 64 }),
    fundTarget: readSeiAmount(env, 'BENCH_FUND_SEI', '3'),
    gapIndex: readInteger(env, 'BENCH_GAP_INDEX', Math.floor(txs / 2), { min: 0, max: txs - 1 }),
    concurrency: readInteger(env, 'BENCH_CONCURRENCY', 1, { min: 1, max: 64 }),
    receiptDeadlineMs: readInteger(env, 'BENCH_RECEIPT_DEADLINE_MS', 90_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    resultsPath:
      env.BENCH_RESULTS_PATH?.trim() ||
      resolve(dirname(fileURLToPath(import.meta.url)), '../.state/bench/baseline-results.jsonl'),
    label: env.BENCH_LABEL?.trim() || undefined,
  };
}

function readMode(env: EnvSource): BenchMode | 'all' {
  const raw = env.BENCH_MODE?.trim().toLowerCase() || 'pipelined';
  if (raw === 'all') return 'all';
  const mode = ALL_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    throw new Error(`BENCH_MODE must be one of ${[...ALL_MODES, 'all'].join(', ')}; received ${raw}`);
  }
  return mode;
}

function readSender(env: EnvSource): 'trader' | 'bench' {
  const raw = env.BENCH_SENDER?.trim().toLowerCase() || 'trader';
  if (raw !== 'trader' && raw !== 'bench') {
    throw new Error(`BENCH_SENDER must be trader or bench; received ${raw}`);
  }
  return raw;
}

function readSeiAmount(env: EnvSource, name: string, fallback: string): bigint {
  const value = readDecimal(env, name, fallback);
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must have at most 18 decimal places`);
  }
}

/* -------------------------------- wallets -------------------------------- */

function deriveWallet(mnemonic: string, addressIndex: number, name: string): Sender {
  return { account: mnemonicToAccount(mnemonic, { addressIndex }), walletIndex: addressIndex, name };
}

/** Bench wallets must never be the trader or a relayer: they would share a nonce queue with it. */
function assertUnreservedWallets(wallets: Sender[]): void {
  const reserved = new Map<string, string>([[trader.address.toLowerCase(), 'the trader']]);
  relayerAccounts.forEach((relayer, i) => reserved.set(relayer.address.toLowerCase(), `relayer ${i}`));
  const seen = new Set<string>();
  for (const wallet of wallets) {
    const key = wallet.account.address.toLowerCase();
    const clash = reserved.get(key);
    if (clash) {
      throw new Error(
        `${wallet.name} (${wallet.account.address}) is ${clash}; change BENCH_WALLET_START_INDEX`,
      );
    }
    if (seen.has(key)) throw new Error(`duplicate bench wallet ${wallet.account.address}`);
    seen.add(key);
  }
}

/**
 * Tops the wallets up to BENCH_FUND_SEI from the trader, all transfers with
 * consecutive nonces from one confirmed read. Waiting for the last receipt is
 * enough: Sei cannot mine a later nonce before an earlier one.
 */
async function ensureFunded(ctx: ModeContext, wallets: Sender[]): Promise<void> {
  const shortfalls: { wallet: Sender; topUp: bigint }[] = [];
  for (const wallet of wallets) {
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    if (balance < ctx.settings.fundTarget) {
      shortfalls.push({ wallet, topUp: ctx.settings.fundTarget - balance });
    }
  }
  if (shortfalls.length === 0) return;

  const total = shortfalls.reduce((sum, { topUp }) => sum + topUp, 0n);
  const gasCost = TRANSFER_GAS * ctx.fees.maxFeePerGas * BigInt(shortfalls.length);
  const traderBalance = await publicClient.getBalance({ address: trader.address });
  if (traderBalance < total + gasCost) {
    throw new Error(
      `trader holds ${formatEther(traderBalance)} SEI but topping up ${shortfalls.length} wallet(s) to ` +
        `${formatEther(ctx.settings.fundTarget)} SEI needs ${formatEther(total + gasCost)} SEI; ` +
        `lower BENCH_FUND_SEI or fund ${trader.address}`,
    );
  }

  const start = await publicClient.getTransactionCount({ address: trader.address, blockTag: 'latest' });
  let lastHash: Hex | undefined;
  for (const [i, { wallet, topUp }] of shortfalls.entries()) {
    const raw = await trader.signTransaction({
      chainId: chain.id,
      type: 'eip1559',
      to: wallet.account.address,
      value: topUp,
      gas: TRANSFER_GAS,
      nonce: start + i,
      maxFeePerGas: ctx.fees.maxFeePerGas,
      maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas,
    });
    lastHash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
    console.log(
      `fund           ${wallet.name.padEnd(10)} ${wallet.account.address}  +${formatEther(topUp)} SEI  trader nonce ${start + i}`,
    );
  }
  if (lastHash) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: lastHash,
      timeout: ctx.settings.receiptDeadlineMs,
    });
    if (receipt.status !== 'success') throw new Error(`funding transfer ${lastHash} reverted`);
    console.log(`fund           ${shortfalls.length} transfer(s) mined by block ${receipt.blockNumber}`);
  }
}

/* --------------------------------- build --------------------------------- */

/** Both tags, so the report can show whether this node's pending view agreed with the chain. */
async function sampleNonces(address: Address): Promise<NonceSample> {
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address, blockTag: 'pending' }),
  ]);
  return { latest, pending };
}

/**
 * One confirmed nonce read, one gas estimate, then N signatures without touching
 * the network again. Signing is separated from broadcasting so the throughput
 * numbers measure the chain and the mempool, not secp256k1.
 */
async function prepare(ctx: ModeContext, sender: Sender, count: number): Promise<Prepared> {
  const address = sender.account.address;
  const nonceBefore = await sampleNonces(address);

  // Millisecond run id, then wallet slot, then index: distinct wallets in one run
  // sit fewer than 100 slots apart, so their ranges cannot overlap within the
  // same millisecond, and successive phases are seconds apart.
  const runId = BigInt(Date.now());
  const orderId = (i: number) => runId * 1_000_000n + BigInt(sender.walletIndex) * 10_000n + BigInt(i);
  const callData = (id: bigint) =>
    encodeFunctionData({ abi: venueAbi, functionName: 'place', args: [id, QTY, ctx.markPx] });

  // The address, not the account object: viem otherwise prepares a full request
  // for a local account, including a `pending` nonce read this script must not
  // depend on. The probe id is one past the last real index and is never signed.
  const estimated = await publicClient.estimateGas({
    account: address,
    to: ctx.venue,
    data: callData(orderId(count)),
  });
  const gas = (estimated * 125n + 99n) / 100n;

  // Admission checks gas x maxFeePerGas per transaction, and the whole sequence
  // must clear it, or the first underfunded nonce strands everything behind it.
  const worstCase = gas * ctx.fees.maxFeePerGas * BigInt(count);
  const balance = await publicClient.getBalance({ address });
  if (balance < worstCase) {
    throw new Error(
      `${sender.name} ${address} holds ${formatEther(balance)} SEI; ${count} x ${gas} gas at ` +
        `${formatUnits(ctx.fees.maxFeePerGas, 9)} gwei needs ${formatEther(worstCase)} SEI`,
    );
  }

  const signStart = Date.now();
  const txs: SignedTx[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = orderId(i);
    const nonce = nonceBefore.latest + i;
    const raw = await sender.account.signTransaction({
      chainId: chain.id,
      type: 'eip1559',
      to: ctx.venue,
      data: callData(id),
      gas,
      nonce,
      maxFeePerGas: ctx.fees.maxFeePerGas,
      maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas,
    });
    txs.push({ index: i, nonce, orderId: id, hash: keccak256(raw), raw });
  }
  const signMs = Date.now() - signStart;

  console.log(
    `${sender.name.padEnd(14)} ${address}  nonce latest ${nonceBefore.latest} pending ${nonceBefore.pending}` +
      `${nonceBefore.latest === nonceBefore.pending ? '' : '  DIFFER'}`,
  );
  console.log(
    `               signed ${count} in ${signMs}ms, nonces ${nonceBefore.latest}..${nonceBefore.latest + count - 1}, ` +
      `gas ${gas} (estimate ${estimated})`,
  );
  return { sender, nonceBefore, gas, txs, signMs };
}

/* ------------------------------- broadcast ------------------------------- */

async function broadcast(client: Broadcaster, tx: SignedTx): Promise<Broadcast> {
  const sentAt = Date.now();
  try {
    const hash = await client.sendRawTransaction({ serializedTransaction: tx.raw });
    if (hash !== tx.hash) {
      console.warn(`  nonce ${tx.nonce}: node returned ${hash}, local hash ${tx.hash}`);
    }
    return { kind: 'accepted', tx, sentAt, doneAt: Date.now() };
  } catch (error) {
    // Verbatim first line, not viem's classification: the exact string is a finding.
    return { kind: 'rejected', tx, error: describeError(error), sentAt, doneAt: Date.now() };
  }
}

/**
 * Workers pull the next index in nonce order. With one worker the wire order is
 * the nonce order. With more, requests overtake each other on the way to the
 * node, and Sei rejects whichever arrives above a nonce it has not seen yet.
 */
async function broadcastInOrder(
  client: Broadcaster,
  txs: SignedTx[],
  concurrency: number,
  skip?: (index: number) => boolean,
): Promise<Submission> {
  const broadcasts: Broadcast[] = txs.map((tx) => ({ kind: 'skipped', tx }));
  const submitStart = Date.now();
  await mapPool(txs, concurrency, async (tx, i) => {
    if (skip?.(i)) return;
    broadcasts[i] = await broadcast(client, tx);
  });
  const submitEnd = Date.now();
  const accepted = broadcasts.filter((attempt) => attempt.kind === 'accepted').length;
  const rejected = broadcasts.filter((attempt) => attempt.kind === 'rejected').length;
  console.log(`               broadcast ${accepted} accepted, ${rejected} rejected in ${submitEnd - submitStart}ms`);
  return { broadcasts, recovery: [], submitStart, submitEnd };
}

function acceptedTxs(submission: Submission): SignedTx[] {
  const byIndex = new Map<number, SignedTx>();
  for (const attempt of [...submission.broadcasts, ...submission.recovery]) {
    if (attempt.kind === 'accepted') byIndex.set(attempt.tx.index, attempt.tx);
  }
  return [...byIndex.values()].sort((a, b) => a.nonce - b.nonce);
}

/**
 * The highest nonce this phase can still reach: the confirmed start plus the
 * unbroken run of accepted nonces above it. Anything accepted above a hole can
 * only land if a node queued it, and the report treats that as missing.
 */
function reachableNonce(start: number, accepted: SignedTx[]): number {
  const nonces = new Set(accepted.map((tx) => tx.nonce));
  let next = start;
  while (nonces.has(next)) next += 1;
  return next;
}

/* --------------------------------- settle -------------------------------- */

/**
 * One `latest` nonce read per unfinished sender per interval, instead of a
 * receipt watcher per hash. Hundreds of concurrent `waitForTransactionReceipt`
 * calls would each poll the RPC on their own and drown a public endpoint.
 */
async function awaitNonces(
  targets: { address: Address; target: number }[],
  deadlineAt: number,
): Promise<Map<Address, { latest: number; observedAt: number; reached: boolean }>> {
  const observed = new Map<Address, { latest: number; observedAt: number; reached: boolean }>();
  let remaining = targets;
  for (;;) {
    const samples = await Promise.all(
      remaining.map(async (entry) => ({
        entry,
        latest: await publicClient.getTransactionCount({ address: entry.address, blockTag: 'latest' }),
      })),
    );
    const now = Date.now();
    remaining = [];
    for (const { entry, latest } of samples) {
      if (latest >= entry.target) observed.set(entry.address, { latest, observedAt: now, reached: true });
      else if (now >= deadlineAt) observed.set(entry.address, { latest, observedAt: now, reached: false });
      else remaining.push(entry);
    }
    if (remaining.length === 0) return observed;
    await sleep(receiptPollingIntervalMs);
  }
}

async function fetchReceipt(hash: Hex): Promise<Omit<Landed, 'tx'> | undefined> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return {
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      status: receipt.status,
    };
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return undefined;
    throw error;
  }
}

/** Waits for every sender's nonce to reach its target, then collects receipts with a bounded pool. */
async function settleAll(pending: PendingRun[], ctx: ModeContext): Promise<SenderRun[]> {
  const deadlineAt = Date.now() + ctx.settings.receiptDeadlineMs;
  const accepted = pending.map(({ submission }) => acceptedTxs(submission));

  const targets = pending.flatMap((run, i) =>
    run.observed
      ? []
      : [
          {
            address: run.prepared.sender.account.address,
            target: reachableNonce(run.prepared.nonceBefore.latest, accepted[i] ?? []),
          },
        ],
  );
  if (targets.length > 0) {
    console.log(
      `landing        polling latest nonce of ${targets.length} sender(s) every ${receiptPollingIntervalMs}ms, ` +
        `deadline ${ctx.settings.receiptDeadlineMs}ms`,
    );
  }
  const observed = await awaitNonces(targets, deadlineAt);

  const all = accepted.flat();
  console.log(`receipts       fetching ${all.length} with ${RECEIPT_CONCURRENCY} in flight`);
  const receipts = await mapPool(all, RECEIPT_CONCURRENCY, (tx) => fetchReceipt(tx.hash));
  const byHash = new Map<Hex, Omit<Landed, 'tx'> | undefined>();
  all.forEach((tx, i) => byHash.set(tx.hash, receipts[i]));

  const runs: SenderRun[] = [];
  for (const [i, run] of pending.entries()) {
    const address = run.prepared.sender.account.address;
    const landed: Landed[] = [];
    const missingNonces: number[] = [];
    for (const tx of accepted[i] ?? []) {
      const receipt = byHash.get(tx.hash);
      if (receipt) landed.push({ tx, ...receipt });
      else missingNonces.push(tx.nonce);
    }
    const seen = observed.get(address);
    runs.push({
      ...run.prepared,
      ...run.submission,
      landEnd: run.observed?.landEnd ?? seen?.observedAt ?? Date.now(),
      deadlineHit: run.observed?.deadlineHit ?? (seen ? !seen.reached : false),
      landed,
      missingNonces,
      nonceAfter: await sampleNonces(address),
    });
  }
  return runs;
}

/* --------------------------------- modes --------------------------------- */

/** The naive safe loop: send one, wait for its receipt, then the next. */
async function runSerial(ctx: ModeContext, sender: Sender): Promise<SenderRun[]> {
  const prepared = await prepare(ctx, sender, ctx.settings.txs);
  const broadcasts: Broadcast[] = prepared.txs.map((tx) => ({ kind: 'skipped', tx }));
  const submitStart = Date.now();
  let submitEnd = submitStart;
  let landEnd = submitStart;
  let deadlineHit = false;
  for (const tx of prepared.txs) {
    const outcome = await broadcast(publicClient, tx);
    broadcasts[tx.index] = outcome;
    submitEnd = Date.now();
    // Every later nonce would be rejected behind this one, so stop instead of
    // recording N identical rejections.
    if (outcome.kind !== 'accepted') {
      console.log(`               nonce ${tx.nonce} rejected: ${outcome.kind === 'rejected' ? outcome.error : ''}`);
      break;
    }
    try {
      await publicClient.waitForTransactionReceipt({ hash: tx.hash, timeout: ctx.settings.receiptDeadlineMs });
      landEnd = Date.now();
    } catch {
      // settleAll reports it as missing; the next nonce could only queue behind it.
      deadlineHit = true;
      break;
    }
    if ((tx.index + 1) % 10 === 0 || tx.index + 1 === prepared.txs.length) {
      console.log(`               ${tx.index + 1}/${prepared.txs.length} landed after ${landEnd - submitStart}ms`);
    }
  }
  return settleAll(
    [
      {
        prepared,
        submission: { broadcasts, recovery: [], submitStart, submitEnd },
        observed: { landEnd, deadlineHit },
      },
    ],
    ctx,
  );
}

/** Sign all N, broadcast in nonce order without waiting, then wait for the nonce to catch up. */
async function runPipelined(ctx: ModeContext, sender: Sender, concurrency: number): Promise<SenderRun[]> {
  const prepared = await prepare(ctx, sender, ctx.settings.txs);
  const submission = await broadcastInOrder(publicClient, prepared.txs, concurrency);
  return settleAll([{ prepared, submission }], ctx);
}

/**
 * Pipelined with one transaction lost before broadcast. Shows the blast radius
 * of a single hole in a sequential queue, then how long it takes to repair.
 */
async function runPipelinedGap(ctx: ModeContext, sender: Sender): Promise<{ runs: SenderRun[]; extras: Extras }> {
  const prepared = await prepare(ctx, sender, ctx.settings.txs);
  const gapIndex = ctx.settings.gapIndex;
  const gapTx = prepared.txs[gapIndex];
  if (!gapTx) throw new Error(`BENCH_GAP_INDEX ${gapIndex} is outside 0..${prepared.txs.length - 1}`);

  console.log(`               skipping index ${gapIndex} (nonce ${gapTx.nonce}), broadcasting the rest`);
  const submission = await broadcastInOrder(publicClient, prepared.txs, 1, (i) => i === gapIndex);
  const behind = submission.broadcasts.filter((attempt) => attempt.tx.index > gapIndex);
  const rejectedBehindGap = behind.filter((attempt) => attempt.kind === 'rejected').length;
  const admittedBehindGap = behind.filter((attempt) => attempt.kind === 'accepted').length;
  const firstRejected = submission.broadcasts.find(
    (attempt): attempt is Extract<Broadcast, { kind: 'rejected' }> => attempt.kind === 'rejected',
  );
  console.log(
    `               behind the gap: ${rejectedBehindGap} rejected, ${admittedBehindGap} admitted` +
      (firstRejected ? `  first rejection (nonce ${firstRejected.tx.nonce}): ${firstRejected.error}` : ''),
  );

  // Recover: the missing nonce first, then every rejected one, each awaiting the
  // node's answer so they arrive in order.
  const recoveryStart = Date.now();
  const resend = [
    gapTx,
    ...submission.broadcasts
      .filter((attempt) => attempt.kind === 'rejected')
      .map((attempt) => attempt.tx),
  ].sort((a, b) => a.nonce - b.nonce);
  for (const tx of resend) submission.recovery.push(await broadcast(publicClient, tx));
  const recoveryRejected = submission.recovery.filter((attempt) => attempt.kind === 'rejected').length;
  console.log(`               recovery: re-broadcast ${resend.length}, ${recoveryRejected} rejected again`);

  const runs = await settleAll([{ prepared, submission }], ctx);
  const landEnd = runs[0]?.landEnd ?? Date.now();
  return {
    runs,
    extras: {
      gapIndex,
      rejectedBehindGap,
      admittedBehindGap,
      recoveryRebroadcasts: resend.length,
      recoveryRejected,
      recoveryMs: landEnd - recoveryStart,
    },
  };
}

/**
 * All N leave in one JSON-RPC batch, in nonce order. `batchSize` is N so viem
 * never splits it, `wait: 0` closes the batch at the end of this tick, and the
 * calls are issued synchronously so they all fall inside it.
 */
async function runBatch(ctx: ModeContext, sender: Sender): Promise<SenderRun[]> {
  const prepared = await prepare(ctx, sender, ctx.settings.txs);
  const batchClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { batch: { batchSize: prepared.txs.length, wait: 0 } }),
  });

  const submitStart = Date.now();
  const settled = await Promise.allSettled(
    prepared.txs.map((tx) => batchClient.sendRawTransaction({ serializedTransaction: tx.raw })),
  );
  const submitEnd = Date.now();

  const broadcasts = settled.map((result, i): Broadcast => {
    const tx = prepared.txs[i]!;
    return result.status === 'fulfilled'
      ? { kind: 'accepted', tx, sentAt: submitStart, doneAt: submitEnd }
      : { kind: 'rejected', tx, error: describeError(result.reason), sentAt: submitStart, doneAt: submitEnd };
  });
  const accepted = broadcasts.filter((attempt) => attempt.kind === 'accepted').length;
  console.log(
    `               one batch of ${broadcasts.length}: ${accepted} accepted, ${broadcasts.length - accepted} rejected ` +
      `in ${submitEnd - submitStart}ms`,
  );
  return settleAll([{ prepared, submission: { broadcasts, recovery: [], submitStart, submitEnd } }], ctx);
}

/** The usual workaround: independent hot wallets, each a sequential queue of its own, all at once. */
async function runFleet(ctx: ModeContext, wallets: Sender[]): Promise<{ runs: SenderRun[]; extras: Extras }> {
  await ensureFunded(ctx, wallets);
  // Sign everything before the first broadcast so every wallet's queue starts together.
  const prepared: Prepared[] = [];
  for (const wallet of wallets) prepared.push(await prepare(ctx, wallet, ctx.settings.txs));

  const pending = await Promise.all(
    prepared.map(async (run) => ({
      prepared: run,
      submission: await broadcastInOrder(publicClient, run.txs, 1),
    })),
  );
  const runs = await settleAll(pending, ctx);
  return { runs, extras: { fleetSize: wallets.length, perWallet: runs.map(walletRecord) } };
}

/* --------------------------------- report -------------------------------- */

function runStats(run: SenderRun) {
  const attempts = [...run.broadcasts, ...run.recovery];
  const broadcastIndices = new Set(
    attempts.filter((attempt) => attempt.kind !== 'skipped').map((attempt) => attempt.tx.index),
  );
  return {
    accepted: acceptedTxs(run).length,
    rejected: attempts.filter((attempt) => attempt.kind === 'rejected').length,
    skipped: run.txs.length - broadcastIndices.size,
    landed: run.landed.length,
    reverted: run.landed.filter((landed) => landed.status === 'reverted').length,
    missing: run.missingNonces.length,
    submitMs: run.submitEnd - run.submitStart,
    landMs: run.landEnd - run.submitStart,
  };
}

function walletRecord(run: SenderRun): WalletRecord {
  const stats = runStats(run);
  return {
    name: run.sender.name,
    walletIndex: run.sender.walletIndex,
    address: run.sender.account.address,
    accepted: stats.accepted,
    rejected: stats.rejected,
    landed: stats.landed,
    reverted: stats.reverted,
    missing: stats.missing,
    missingNonces: run.missingNonces,
    submitMs: stats.submitMs,
    landMs: stats.landMs,
    tpsClient: perSecond(stats.landed, stats.landMs),
    nonceBefore: run.nonceBefore,
    nonceAfter: run.nonceAfter,
  };
}

async function summarize(
  mode: BenchMode,
  runs: SenderRun[],
  ctx: ModeContext,
  extras: Extras,
): Promise<ModeRecord> {
  const stats = runs.map(runStats);
  const sum = (pick: (s: ReturnType<typeof runStats>) => number) => stats.reduce((acc, s) => acc + pick(s), 0);

  const rejectionsByMessage: Record<string, number> = {};
  for (const run of runs) {
    for (const attempt of [...run.broadcasts, ...run.recovery]) {
      if (attempt.kind === 'rejected') {
        rejectionsByMessage[attempt.error] = (rejectionsByMessage[attempt.error] ?? 0) + 1;
      }
    }
  }

  const submitStart = Math.min(...runs.map((run) => run.submitStart));
  const submitMs = Math.max(...runs.map((run) => run.submitEnd)) - submitStart;
  const landMs = Math.max(...runs.map((run) => run.landEnd)) - submitStart;

  const landed = runs.flatMap((run) => run.landed);
  const blocks = landed.map((entry) => entry.blockNumber);
  const firstBlock = blocks.length > 0 ? blocks.reduce((a, b) => (a < b ? a : b)) : null;
  const lastBlock = blocks.length > 0 ? blocks.reduce((a, b) => (a > b ? a : b)) : null;
  const blockSpan = firstBlock !== null && lastBlock !== null ? Number(lastBlock - firstBlock) + 1 : 0;
  // Sei block timestamps have one-second granularity, so a burst inside one
  // second reads as zero span and tpsChain divides by one instead.
  let chainSpanSeconds = 0;
  if (firstBlock !== null && lastBlock !== null && lastBlock > firstBlock) {
    const [first, last] = await Promise.all([
      publicClient.getBlock({ blockNumber: firstBlock }),
      publicClient.getBlock({ blockNumber: lastBlock }),
    ]);
    chainSpanSeconds = Number(last.timestamp - first.timestamp);
  }

  const totalGasUsed = landed.reduce((acc, entry) => acc + entry.gasUsed, 0n);
  const costWei = landed.reduce((acc, entry) => acc + entry.gasUsed * entry.effectiveGasPrice, 0n);
  const single = runs.length === 1 ? runs[0] : undefined;

  return {
    mode,
    ...(ctx.settings.label ? { label: ctx.settings.label } : {}),
    timestamp: new Date().toISOString(),
    chainId: chain.id,
    senders: runs.map((run) => run.sender.account.address),
    txsRequested: runs.reduce((acc, run) => acc + run.txs.length, 0),
    accepted: sum((s) => s.accepted),
    rejected: sum((s) => s.rejected),
    skipped: sum((s) => s.skipped),
    rejectionsByMessage,
    landed: landed.length,
    reverted: sum((s) => s.reverted),
    missing: sum((s) => s.missing),
    missingNonces: single ? single.missingNonces : [],
    deadlineHit: runs.some((run) => run.deadlineHit),
    submitMs,
    landMs,
    tpsClient: perSecond(landed.length, landMs),
    firstBlock,
    lastBlock,
    blockSpan,
    chainSpanSeconds,
    tpsChain: landed.length / Math.max(chainSpanSeconds, 1),
    landedPerBlock: blockSpan > 0 ? landed.length / blockSpan : 0,
    totalGasUsed,
    avgGasPerTx: landed.length > 0 ? totalGasUsed / BigInt(landed.length) : 0n,
    gasLimitPerTx: runs[0]?.gas ?? 0n,
    costWei,
    costSei: formatEther(costWei),
    maxFeePerGas: ctx.fees.maxFeePerGas,
    maxPriorityFeePerGas: ctx.fees.maxPriorityFeePerGas,
    ...(single ? { nonceBefore: single.nonceBefore, nonceAfter: single.nonceAfter } : {}),
    blockGasLimit: ctx.blockGasLimit,
    signMs: runs.reduce((acc, run) => acc + run.signMs, 0),
    ...extras,
  };
}

function printSummary(record: ModeRecord, firstLanded: Hex | undefined): void {
  const line = (key: string, value: string) => console.log(`${key.padEnd(22)} ${value}`);
  console.log(`\n=== ${record.mode}: summary${record.label ? ` (${record.label})` : ''} ===`);
  line('senders', record.senders.length === 1 ? record.senders[0]! : `${record.senders.length} wallets`);
  line('txs requested', String(record.txsRequested));
  line('accepted', `${record.accepted}  rejected ${record.rejected}  never sent ${record.skipped}`);
  line(
    'landed',
    `${record.landed}  reverted ${record.reverted}  missing ${record.missing}` +
      (record.deadlineHit ? '  DEADLINE HIT' : ''),
  );
  line('submit time', `${record.submitMs}ms  (first broadcast -> last broadcast response)`);
  line('land time', `${record.landMs}ms  (first broadcast -> last receipt observed)`);
  line('throughput client', `${record.tpsClient.toFixed(2)} landed tx/s`);
  if (record.firstBlock !== null && record.lastBlock !== null) {
    line(
      'blocks',
      `${record.firstBlock}..${record.lastBlock}  span ${record.blockSpan}, ${record.chainSpanSeconds}s on chain (1s granularity)`,
    );
    line(
      'throughput chain',
      `${record.tpsChain.toFixed(2)} tx/s over max(span,1)s  ${record.landedPerBlock.toFixed(2)} landed/block`,
    );
  }
  line(
    'gas',
    `total ${record.totalGasUsed}  avg ${record.avgGasPerTx}  limit ${record.gasLimitPerTx}/tx  block limit ${record.blockGasLimit}`,
  );
  line('cost', `${record.costSei} SEI at max ${formatUnits(record.maxFeePerGas, 9)} gwei`);
  if (record.nonceBefore && record.nonceAfter) {
    line(
      'nonce',
      `latest ${record.nonceBefore.latest} -> ${record.nonceAfter.latest}  ` +
        `pending ${record.nonceBefore.pending} -> ${record.nonceAfter.pending}`,
    );
  }
  for (const [message, count] of Object.entries(record.rejectionsByMessage)) {
    line('rejection', `${count} x ${message}`);
  }
  if (record.missingNonces.length > 0) line('missing nonces', record.missingNonces.join(', '));
  if (record.concurrency !== undefined) line('concurrency', String(record.concurrency));
  if (record.gapIndex !== undefined) {
    line('gap', `index ${record.gapIndex}  rejected behind it ${record.rejectedBehindGap}  admitted behind it ${record.admittedBehindGap}`);
    line(
      'recovery',
      `${record.recoveryRebroadcasts} re-broadcast, ${record.recoveryRejected} rejected again, landed ${record.recoveryMs}ms after recovery began`,
    );
  }
  if (record.perWallet) {
    line('fleet', `${record.fleetSize} wallets`);
    for (const wallet of record.perWallet) {
      line(
        `  ${wallet.name}`,
        `${wallet.address}  accepted ${wallet.accepted}  landed ${wallet.landed}  reverted ${wallet.reverted}  ` +
          `missing ${wallet.missing}  ${wallet.tpsClient.toFixed(2)} tx/s` +
          (wallet.missingNonces.length > 0 ? `  missing nonces ${wallet.missingNonces.join(', ')}` : ''),
      );
    }
  }
  if (firstLanded) line('example tx', explorerTx(firstLanded));
}

async function appendRecord(path: string, record: ModeRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record, jsonReplacer)}\n`, 'utf8');
}

/* -------------------------------- helpers -------------------------------- */

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

/**
 * One line, never the whole message. viem's first line is its own classification
 * ("Missing or invalid parameters.") and the body quotes the request URL; the
 * node's verbatim reason lives in `details`, and that string is the finding.
 */
function describeError(error: unknown): string {
  if (error instanceof BaseError && error.details) return firstLine(error.details);
  if (error instanceof Error) return firstLine(error.message);
  return String(error);
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.trim();
}

function perSecond(count: number, ms: number): number {
  return ms > 0 ? count / (ms / 1000) : 0;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const startedAt = Date.now();
  await assertWriteNetwork('bench');
  const venue = venueAddress;
  if (!venue) throw new Error('Set VENUE in .env');
  const settings = readSettings(process.env);

  const modes: BenchMode[] =
    settings.mode === 'all'
      ? ALL_MODES.filter((mode) => mode !== 'fleet' || settings.fleetSize > 0)
      : [settings.mode];
  if (modes.includes('fleet') && settings.fleetSize === 0) {
    throw new Error('BENCH_MODE=fleet needs BENCH_FLEET_SIZE > 0');
  }

  // env.ts validated the mnemonic at import; it derives the bench wallets too,
  // so BENCH_WALLET_START_INDEX must stay clear of the relayer indices.
  const mnemonic = readMnemonic(process.env, 'RELAYER_MNEMONIC');
  const primary: Sender =
    settings.sender === 'trader'
      ? { account: trader, walletIndex: 0, name: 'trader' }
      : deriveWallet(mnemonic, settings.walletStartIndex, `bench#${settings.walletStartIndex}`);
  const fleet = modes.includes('fleet')
    ? Array.from({ length: settings.fleetSize }, (_, i) => {
        const index = settings.walletStartIndex + 1 + i;
        return deriveWallet(mnemonic, index, `fleet#${index}`);
      })
    : [];
  assertUnreservedWallets([...(settings.sender === 'bench' ? [primary] : []), ...fleet]);

  /* ------------------------------- preflight ------------------------------- */

  console.log('=== preflight ===');
  console.log(`chain          ${chain.name} (${chain.id})`);
  console.log(`rpc            ${displayRpcUrl()}`);
  const [block, venueCode, markPx] = await Promise.all([
    publicClient.getBlock(),
    publicClient.getCode({ address: venue }),
    publicClient.readContract({ address: venue, abi: venueAbi, functionName: 'markPx' }),
  ]);
  if (!venueCode) throw new Error(`VENUE ${venue} has no code`);
  console.log(`block          ${block.number}  gas limit ${block.gasLimit}`);
  console.log(`venue          ${venue}  mark ${formatUnits(markPx, 18)}`);
  for (const sender of [primary, ...fleet]) {
    const [balance, nonces] = await Promise.all([
      publicClient.getBalance({ address: sender.account.address }),
      sampleNonces(sender.account.address),
    ]);
    console.log(
      `${sender.name.padEnd(14)} ${sender.account.address}  ${formatEther(balance)} SEI  ` +
        `nonce latest ${nonces.latest} pending ${nonces.pending}${nonces.latest === nonces.pending ? '' : '  DIFFER'}`,
    );
  }
  console.log(`modes          ${modes.join(', ')}  (${settings.txs} txs per sender)`);
  if (settings.label) console.log(`label          ${settings.label}`);
  console.log(`results        ${settings.resultsPath}`);

  /* --------------------------------- run ---------------------------------- */

  let unmined = 0;
  for (const [i, mode] of modes.entries()) {
    console.log(`\n=== ${mode} ===`);
    const estimated = await publicClient.estimateFeesPerGas();
    const ctx: ModeContext = {
      settings,
      venue,
      markPx,
      blockGasLimit: block.gasLimit,
      fees: { maxFeePerGas: estimated.maxFeePerGas * 2n, maxPriorityFeePerGas: estimated.maxPriorityFeePerGas * 2n },
    };
    console.log(
      `fees           max ${formatUnits(ctx.fees.maxFeePerGas, 9)} gwei  priority ${formatUnits(ctx.fees.maxPriorityFeePerGas, 9)} gwei (2x estimate)`,
    );
    if (settings.sender === 'bench' && mode !== 'fleet') await ensureFunded(ctx, [primary]);

    let runs: SenderRun[];
    let extras: Extras = {};
    switch (mode) {
      case 'serial':
        runs = await runSerial(ctx, primary);
        break;
      case 'pipelined':
        if (settings.concurrency > 1) {
          console.log(
            `concurrency    ${settings.concurrency} in flight: wire order is no longer nonce order, so rejections here show what reordering costs`,
          );
        }
        runs = await runPipelined(ctx, primary, settings.concurrency);
        extras = { concurrency: settings.concurrency };
        break;
      case 'pipelined-gap':
        ({ runs, extras } = await runPipelinedGap(ctx, primary));
        break;
      case 'batch':
        runs = await runBatch(ctx, primary);
        break;
      case 'fleet':
        ({ runs, extras } = await runFleet(ctx, fleet));
        break;
    }

    const record = await summarize(mode, runs, ctx, extras);
    const firstLanded = runs.flatMap((run) => run.landed).sort((a, b) => a.tx.nonce - b.tx.nonce)[0]?.tx.hash;
    printSummary(record, firstLanded);
    await appendRecord(settings.resultsPath, record);
    console.log(`recorded       ${settings.resultsPath}`);

    if (record.missing > 0) {
      unmined += record.missing;
      // Accepted-but-unmined transactions may still land later and would sit
      // under the next phase's confirmed nonce read, so do not start one.
      if (i + 1 < modes.length) {
        console.log(`\nstopping before ${modes[i + 1]}: ${record.missing} accepted transaction(s) are still unmined`);
        break;
      }
    }
  }

  console.log(`\ntotal wall time ${Date.now() - startedAt}ms`);
  if (unmined > 0) {
    console.error(`${unmined} accepted transaction(s) never mined before the deadline`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // The whole error, minus the credential-bearing RPC URL viem quotes in its messages.
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(text.split(rpcUrl).join(displayRpcUrl()));
  process.exitCode = 1;
});
