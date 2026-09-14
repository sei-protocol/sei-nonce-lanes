/**
 * Chain-side throughput report for a block range on Sei.
 *
 * The senders print "landed ops/sec" as measured from the client, which folds
 * RPC latency and receipt polling into the number. This reads back what the
 * chain actually included per block so the two can be compared: blocks sitting
 * near the gas limit mean the chain is the ceiling; mostly empty blocks mean
 * the client is. Sei stamps blocks at 1 s granularity while producing several
 * per second, so figures are given per block and per 1 s timestamp bucket.
 *
 * Read-only. Inputs are REPORT_* environment variables (see `readSettings`):
 *
 *   REPORT_FROM_BLOCK / REPORT_TO_BLOCK   inclusive decimal range, or
 *   REPORT_TX_HASHES / REPORT_TX_HASHES_FILE   receipts define [min, max] block
 *   REPORT_PAD_BLOCKS      widen the range on both sides (default 0)
 *   REPORT_ENTRY_POINT     default ENTRY_POINT from env.ts
 *   REPORT_VENUE           default VENUE from env.ts; unset skips venue stats
 *   REPORT_SENDER          only count this sender's ops and this trader's Placed
 *   REPORT_LOG_CHUNK       max blocks per getLogs (default 500, halves on error)
 *   REPORT_MAX_BLOCKS      refuse wider ranges (default 5000)
 *   REPORT_JSON=1          one JSON document on stdout, bigints as strings
 *
 *   cd app && REPORT_FROM_BLOCK=… REPORT_TO_BLOCK=… npx tsx bench/block-report.ts
 */
import { readFile } from 'node:fs/promises';
import {
  BaseError,
  getAbiItem,
  getAddress,
  isHash,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import { entryPointAbi } from '../src/abi.js';
import { readFlag, readInteger, readOptionalAddress, type EnvSource } from '../src/config.js';
import { ENTRY_POINT, chain, displayRpcUrl, publicClient, venueAddress } from '../src/env.js';

/** Parallel block and receipt lookups. Public Sei endpoints start throttling above this. */
const RPC_CONCURRENCY = 8;
/** A block at or above this share of gasLimit counts as full: the chain, not the client, is the ceiling. */
const FULL_BLOCK_PERCENT = 90;

const userOperationEvent = getAbiItem({ abi: entryPointAbi, name: 'UserOperationEvent' });

/** `MockPerpVenue.Placed`. Not in `venueAbi`, which only carries what the senders call. */
const placedEvent = {
  type: 'event',
  name: 'Placed',
  inputs: [
    { name: 'orderId', type: 'uint256', indexed: true },
    { name: 'trader', type: 'address', indexed: true },
    { name: 'seq', type: 'uint256', indexed: false },
    { name: 'qty', type: 'uint256', indexed: false },
    { name: 'fillPx', type: 'uint256', indexed: false },
  ],
} as const satisfies AbiEvent;

type Settings = {
  fromBlock: bigint | undefined;
  toBlock: bigint | undefined;
  txHashesInline: string;
  txHashesFile: string | undefined;
  padBlocks: number;
  entryPoint: Address;
  venue: Address | undefined;
  sender: Address | undefined;
  logChunk: number;
  json: boolean;
  maxBlocks: number;
};

type Range = { from: bigint; to: bigint; head: bigint; source: string; clampedToHead: boolean };

type BlockRow = {
  number: bigint;
  timestamp: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  txCount: number;
};

type UserOpLog = {
  blockNumber: bigint;
  transactionHash: Hex;
  sender: Address;
  success: boolean;
  actualGasUsed: bigint;
};

type PlacedLog = { blockNumber: bigint; transactionHash: Hex; trader: Address };

type BundleReceipt = { gasUsed: bigint; from: Address; status: 'success' | 'reverted' };

/** The logs of one range, either everything or only the filtered sender/trader. */
type View = { userOps: readonly UserOpLog[]; placed: readonly PlacedLog[] };

type Context = {
  blocks: readonly BlockRow[];
  /** Every handleOps tx in range, unfiltered: a Placed log came "via lanes" iff its tx is one of these. */
  bundleTxs: ReadonlySet<Hex>;
  receipts: ReadonlyMap<Hex, BundleReceipt>;
  hasVenue: boolean;
};

type BlockStats = {
  block: BlockRow;
  offsetSeconds: bigint;
  bundles: Set<Hex>;
  userOpsOk: number;
  userOpsFail: number;
  placedLanes: number;
  placedDirect: number;
};

type Bundle = { hash: Hex; blockNumber: bigint; ops: number } & BundleReceipt;

type Summary = {
  blocksInRange: number;
  activeBlocks: number;
  spanSeconds: bigint;
  blocksPerSecond: number;
  userOps: number;
  userOpsOk: number;
  userOpsFail: number;
  bundles: number;
  revertedBundles: number;
  avgOpsPerBundle: number;
  maxOpsInBundle: number;
  avgOuterGasPerBundle: bigint | null;
  avgOuterGasPerOp: bigint | null;
  avgActualGasUsedPerOp: bigint | null;
  placed: { total: number; lanes: number; direct: number } | null;
  opsPerSecond: number;
  peakBlock: { number: bigint; ops: number } | null;
  peakSecond: { timestamp: bigint; blocks: number; ops: number } | null;
  gas: {
    limit: bigint;
    avgUtilisationPercent: number;
    maxUtilisationPercent: number;
    fullBlocks: number;
  };
  relayers: Address[];
  ceiling: { opsPerBlock: number; opsPerSecond: number } | null;
};

type Aggregate = { rows: BlockStats[]; bundles: Bundle[]; summary: Summary };

type Column<T> = { header: string; cell: (row: T) => string };

async function main(): Promise<void> {
  const settings = readSettings(process.env);
  const head = await publicClient.getBlockNumber();
  const range = await resolveRange(settings, head);
  // JSON mode owns stdout, so progress and the human report go nowhere.
  const log: (line: string) => void = settings.json ? () => undefined : (line) => console.log(line);

  log('=== block report preflight ===');
  log(`chain          ${chain.name} (${chain.id})`);
  log(`rpc            ${displayRpcUrl()}`);
  log(`head           ${range.head}`);
  log(
    `range          ${range.from}..${range.to}  (${range.to - range.from + 1n} blocks, pad ${settings.padBlocks}` +
      `${range.clampedToHead ? ', end clamped to head' : ''})`,
  );
  log(`range source   ${range.source}`);
  log(`entryPoint     ${settings.entryPoint}`);
  log(`venue          ${settings.venue ?? 'unset (venue stats skipped)'}`);
  log(`sender filter  ${settings.sender ?? 'none'}`);
  log(`log chunk      <=${settings.logChunk} blocks per getLogs`);
  log(`fetching       blocks and EntryPoint logs${settings.venue ? ', venue logs' : ''}, then bundle receipts`);

  const [blocks, userOps, placed] = await Promise.all([
    fetchBlocks(range),
    fetchUserOps(range, settings.entryPoint, settings.logChunk),
    settings.venue
      ? fetchPlaced(range, settings.venue, settings.logChunk)
      : Promise.resolve<PlacedLog[]>([]),
  ]);
  const bundleTxs = new Set(userOps.map((op) => op.transactionHash));
  const receipts = await fetchBundleReceipts([...bundleTxs]);
  const context: Context = { blocks, bundleTxs, receipts, hasVenue: settings.venue !== undefined };

  const all = aggregate({ userOps, placed }, context);
  const filtered = settings.sender
    ? aggregate(filterView({ userOps, placed }, settings.sender), context)
    : undefined;
  const primary = filtered ?? all;

  if (settings.json) {
    console.log(JSON.stringify(toJson(settings, range, context, primary, filtered ? all : undefined), jsonReplacer, 2));
    return;
  }

  log('');
  log(`=== per block${settings.sender ? ` (sender ${settings.sender})` : ''} ===`);
  for (const line of renderTable(primary.rows, blockColumns(context.hasVenue))) log(line);
  log('');
  log('=== totals ===');
  printSummary(primary, filtered ? all : undefined, settings.sender);
}

function readSettings(env: EnvSource): Settings {
  return {
    fromBlock: readOptionalBlockNumber(env, 'REPORT_FROM_BLOCK'),
    toBlock: readOptionalBlockNumber(env, 'REPORT_TO_BLOCK'),
    txHashesInline: env.REPORT_TX_HASHES?.trim() ?? '',
    txHashesFile: env.REPORT_TX_HASHES_FILE?.trim() || undefined,
    padBlocks: readInteger(env, 'REPORT_PAD_BLOCKS', 0, { min: 0 }),
    entryPoint: readOptionalAddress(env, 'REPORT_ENTRY_POINT') ?? ENTRY_POINT,
    venue: readOptionalAddress(env, 'REPORT_VENUE') ?? venueAddress,
    sender: readOptionalAddress(env, 'REPORT_SENDER'),
    logChunk: readInteger(env, 'REPORT_LOG_CHUNK', 500, { min: 1, max: 5000 }),
    json: readFlag(env, 'REPORT_JSON'),
    maxBlocks: readInteger(env, 'REPORT_MAX_BLOCKS', 5000, { min: 1 }),
  };
}

function readOptionalBlockNumber(env: EnvSource, name: string): bigint | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a decimal block number; received ${raw}`);
  return BigInt(raw);
}

/** Accepts comma/whitespace-separated hashes inline and one-per-line in a file, deduplicated. */
async function readTxHashes(settings: Settings): Promise<Hex[]> {
  const fromFile = settings.txHashesFile ? await readFile(settings.txHashesFile, 'utf8') : '';
  const hashes = new Set<Hex>();
  for (const token of `${settings.txHashesInline}\n${fromFile}`.split(/[\s,]+/)) {
    if (!token) continue;
    const hash = token.toLowerCase();
    if (!isHash(hash)) throw new Error(`REPORT_TX_HASHES: "${token}" is not a 32-byte transaction hash`);
    hashes.add(hash);
  }
  return [...hashes];
}

async function resolveRange(settings: Settings, head: bigint): Promise<Range> {
  const seed = await seedRange(settings);
  const pad = BigInt(settings.padBlocks);
  const from = seed.from > pad ? seed.from - pad : 0n;
  // Padding past the head would only produce BlockNotFound errors, so stop at the chain tip.
  const to = seed.to + pad > head ? head : seed.to + pad;
  if (to < from) throw new Error(`Range start ${from} is beyond the chain head ${head}`);
  const blocks = to - from + 1n;
  if (blocks > BigInt(settings.maxBlocks)) {
    throw new Error(
      `Range ${from}..${to} spans ${blocks} blocks, above REPORT_MAX_BLOCKS=${settings.maxBlocks}. ` +
        'Narrow the range or raise the limit.',
    );
  }
  return { from, to, head, source: seed.source, clampedToHead: seed.to + pad > head };
}

async function seedRange(settings: Settings): Promise<Pick<Range, 'from' | 'to' | 'source'>> {
  const hasHashes = settings.txHashesInline !== '' || settings.txHashesFile !== undefined;
  if (settings.fromBlock !== undefined || settings.toBlock !== undefined) {
    if (settings.fromBlock === undefined || settings.toBlock === undefined) {
      throw new Error('Set both REPORT_FROM_BLOCK and REPORT_TO_BLOCK');
    }
    if (settings.toBlock < settings.fromBlock) {
      throw new Error(`REPORT_TO_BLOCK (${settings.toBlock}) is below REPORT_FROM_BLOCK (${settings.fromBlock})`);
    }
    // An explicit range wins so a saved hash list can be re-examined over another window without unsetting it.
    return {
      from: settings.fromBlock,
      to: settings.toBlock,
      source: `REPORT_FROM_BLOCK..REPORT_TO_BLOCK${hasHashes ? ' (REPORT_TX_HASHES ignored)' : ''}`,
    };
  }
  const hashes = await readTxHashes(settings);
  if (hashes.length === 0) {
    throw new Error('Set REPORT_FROM_BLOCK and REPORT_TO_BLOCK, or REPORT_TX_HASHES / REPORT_TX_HASHES_FILE');
  }
  const receipts = await mapPool(hashes, RPC_CONCURRENCY, (hash) => publicClient.getTransactionReceipt({ hash }));
  const numbers = receipts.map((receipt) => receipt.blockNumber);
  const from = numbers.reduce((min, value) => (value < min ? value : min));
  const to = numbers.reduce((max, value) => (value > max ? value : max));
  return { from, to, source: `${hashes.length} tx receipt(s) landed in blocks ${from}..${to}` };
}

async function fetchBlocks(range: Range): Promise<BlockRow[]> {
  const numbers: bigint[] = [];
  for (let n = range.from; n <= range.to; n += 1n) numbers.push(n);
  return mapPool(numbers, RPC_CONCURRENCY, async (blockNumber) => {
    const block = await publicClient.getBlock({ blockNumber, includeTransactions: false });
    return {
      number: blockNumber,
      timestamp: block.timestamp,
      gasUsed: block.gasUsed,
      gasLimit: block.gasLimit,
      txCount: block.transactions.length,
    };
  });
}

async function fetchUserOps(range: Range, entryPoint: Address, chunk: number): Promise<UserOpLog[]> {
  const logs = await fetchLogsChunked(range, chunk, 'UserOperationEvent', (fromBlock, toBlock) =>
    publicClient.getLogs({ address: entryPoint, event: userOperationEvent, fromBlock, toBlock, strict: true }),
  );
  return logs.map((log) => ({
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    sender: log.args.sender,
    success: log.args.success,
    actualGasUsed: log.args.actualGasUsed,
  }));
}

async function fetchPlaced(range: Range, venue: Address, chunk: number): Promise<PlacedLog[]> {
  const logs = await fetchLogsChunked(range, chunk, 'Placed', (fromBlock, toBlock) =>
    publicClient.getLogs({ address: venue, event: placedEvent, fromBlock, toBlock, strict: true }),
  );
  return logs.map((log) => ({
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    trader: log.args.trader,
  }));
}

/** Walks the range in chunks; public RPCs cap getLogs by span or result size, so halve and retry until one block fails. */
async function fetchLogsChunked<T>(
  range: Range,
  chunkBlocks: number,
  label: string,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let size = BigInt(chunkBlocks);
  let cursor = range.from;
  while (cursor <= range.to) {
    const end = cursor + size - 1n > range.to ? range.to : cursor + size - 1n;
    try {
      // Push one by one: a spread of a very large log batch would overflow the argument limit.
      for (const item of await fetch(cursor, end)) out.push(item);
      cursor = end + 1n;
    } catch (error) {
      if (size === 1n) throw error;
      size /= 2n;
      console.warn(
        `${label}: getLogs ${cursor}..${end} failed (${describeError(error)}); retrying with ${size}-block chunks`,
      );
    }
  }
  return out;
}

/** Bundle receipts give the exact outer gas, which the UserOperationEvent's actualGasUsed only approximates. */
async function fetchBundleReceipts(hashes: readonly Hex[]): Promise<Map<Hex, BundleReceipt>> {
  const entries = await mapPool(hashes, RPC_CONCURRENCY, async (hash) => {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return [hash, { gasUsed: receipt.gasUsed, from: receipt.from, status: receipt.status }] as const;
  });
  return new Map(entries);
}

function filterView(view: View, sender: Address): View {
  const wanted = sender.toLowerCase();
  return {
    userOps: view.userOps.filter((op) => op.sender.toLowerCase() === wanted),
    placed: view.placed.filter((event) => event.trader.toLowerCase() === wanted),
  };
}

function aggregate(view: View, context: Context): Aggregate {
  const first = context.blocks[0];
  const last = context.blocks[context.blocks.length - 1];
  if (!first || !last) throw new Error('Block range is empty');

  const byBlock = new Map<bigint, BlockStats>();
  for (const block of context.blocks) {
    byBlock.set(block.number, {
      block,
      offsetSeconds: block.timestamp - first.timestamp,
      bundles: new Set(),
      userOpsOk: 0,
      userOpsFail: 0,
      placedLanes: 0,
      placedDirect: 0,
    });
  }
  const statsFor = (blockNumber: bigint): BlockStats => {
    const stats = byBlock.get(blockNumber);
    // getLogs was bounded to the range, so a miss means the RPC answered for a different one.
    if (!stats) throw new Error(`RPC returned a log for block ${blockNumber}, outside the requested range`);
    return stats;
  };

  const opsPerBundle = new Map<Hex, { blockNumber: bigint; ops: number }>();
  let actualGasUsedSum = 0n;
  for (const op of view.userOps) {
    const stats = statsFor(op.blockNumber);
    stats.bundles.add(op.transactionHash);
    if (op.success) stats.userOpsOk += 1;
    else stats.userOpsFail += 1;
    actualGasUsedSum += op.actualGasUsed;
    const bundle = opsPerBundle.get(op.transactionHash);
    if (bundle) bundle.ops += 1;
    else opsPerBundle.set(op.transactionHash, { blockNumber: op.blockNumber, ops: 1 });
  }
  for (const event of view.placed) {
    const stats = statsFor(event.blockNumber);
    if (context.bundleTxs.has(event.transactionHash)) stats.placedLanes += 1;
    else stats.placedDirect += 1;
  }

  const bundles: Bundle[] = [...opsPerBundle].map(([hash, { blockNumber, ops }]) => {
    const receipt = context.receipts.get(hash);
    if (!receipt) throw new Error(`No receipt fetched for bundle ${hash}`);
    return { hash, blockNumber, ops, ...receipt };
  });

  const rows = [...byBlock.values()];
  const ops = view.userOps.length;
  const opsOk = view.userOps.filter((op) => op.success).length;
  const outerGasSum = bundles.reduce((sum, bundle) => sum + bundle.gasUsed, 0n);
  const spanSeconds = last.timestamp - first.timestamp;
  // Timestamps are whole seconds, so a range inside one second still counts as one second of wall time.
  const effectiveSpan = spanSeconds > 0n ? Number(spanSeconds) : 1;
  const blocksPerSecond = rows.length / effectiveSpan;

  let peakBlock: Summary['peakBlock'] = null;
  const perSecond = new Map<bigint, { blocks: number; ops: number }>();
  for (const row of rows) {
    const rowOps = row.userOpsOk + row.userOpsFail;
    if (!peakBlock || rowOps > peakBlock.ops) peakBlock = { number: row.block.number, ops: rowOps };
    const bucket = perSecond.get(row.block.timestamp) ?? { blocks: 0, ops: 0 };
    bucket.blocks += 1;
    bucket.ops += rowOps;
    perSecond.set(row.block.timestamp, bucket);
  }
  let peakSecond: Summary['peakSecond'] = null;
  for (const [timestamp, bucket] of perSecond) {
    if (!peakSecond || bucket.ops > peakSecond.ops) peakSecond = { timestamp, ...bucket };
  }

  const utilisation = rows.map((row) => percentOf(row.block.gasUsed, row.block.gasLimit));
  const gasLimit = context.blocks.reduce((max, block) => (block.gasLimit > max ? block.gasLimit : max), 0n);
  const avgOuterGasPerOp = ops > 0 ? outerGasSum / BigInt(ops) : null;
  const placedLanes = rows.reduce((sum, row) => sum + row.placedLanes, 0);
  const placedDirect = rows.reduce((sum, row) => sum + row.placedDirect, 0);

  return {
    rows,
    bundles,
    summary: {
      blocksInRange: rows.length,
      activeBlocks: rows.filter(
        (row) => row.userOpsOk + row.userOpsFail + row.placedLanes + row.placedDirect > 0,
      ).length,
      spanSeconds,
      blocksPerSecond,
      userOps: ops,
      userOpsOk: opsOk,
      userOpsFail: ops - opsOk,
      bundles: bundles.length,
      revertedBundles: bundles.filter((bundle) => bundle.status === 'reverted').length,
      avgOpsPerBundle: bundles.length > 0 ? ops / bundles.length : 0,
      maxOpsInBundle: bundles.reduce((max, bundle) => Math.max(max, bundle.ops), 0),
      avgOuterGasPerBundle: bundles.length > 0 ? outerGasSum / BigInt(bundles.length) : null,
      avgOuterGasPerOp,
      avgActualGasUsedPerOp: ops > 0 ? actualGasUsedSum / BigInt(ops) : null,
      placed: context.hasVenue
        ? { total: placedLanes + placedDirect, lanes: placedLanes, direct: placedDirect }
        : null,
      opsPerSecond: ops / effectiveSpan,
      peakBlock,
      peakSecond,
      gas: {
        limit: gasLimit,
        avgUtilisationPercent: utilisation.reduce((sum, value) => sum + value, 0) / utilisation.length,
        maxUtilisationPercent: utilisation.reduce((max, value) => Math.max(max, value), 0),
        fullBlocks: utilisation.filter((value) => value >= FULL_BLOCK_PERCENT).length,
      },
      relayers: [...new Set(bundles.map((bundle) => bundle.from.toLowerCase()))].map((address) =>
        getAddress(address),
      ),
      ceiling: ceilingFor(gasLimit, avgOuterGasPerOp, blocksPerSecond),
    },
  };
}

/** How many ops of the observed shape fit in a block if outer gas were the only limit. */
function ceilingFor(
  gasLimit: bigint,
  avgOuterGasPerOp: bigint | null,
  blocksPerSecond: number,
): Summary['ceiling'] {
  if (avgOuterGasPerOp === null || avgOuterGasPerOp === 0n) return null;
  const opsPerBlock = Number(gasLimit) / Number(avgOuterGasPerOp);
  return { opsPerBlock, opsPerSecond: opsPerBlock * blocksPerSecond };
}

function blockColumns(hasVenue: boolean): Column<BlockStats>[] {
  const columns: Column<BlockStats>[] = [
    { header: 'block', cell: (row) => row.block.number.toString() },
    { header: '+s', cell: (row) => row.offsetSeconds.toString() },
    { header: 'txs', cell: (row) => String(row.block.txCount) },
    { header: 'gasUsed', cell: (row) => fmtInt(row.block.gasUsed) },
    { header: '%ofLimit', cell: (row) => percentOf(row.block.gasUsed, row.block.gasLimit).toFixed(1) },
    { header: 'bundles', cell: (row) => String(row.bundles.size) },
    { header: 'userOps ok', cell: (row) => String(row.userOpsOk) },
    { header: 'userOps fail', cell: (row) => String(row.userOpsFail) },
  ];
  if (hasVenue) {
    columns.push(
      { header: 'placed lanes', cell: (row) => String(row.placedLanes) },
      { header: 'placed direct', cell: (row) => String(row.placedDirect) },
    );
  }
  return columns;
}

/** Right-aligned columns sized to the widest cell, so long tables stay scannable. */
function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string[] {
  const body = rows.map((row) => columns.map((column) => column.cell(row)));
  const widths = columns.map((column, i) =>
    body.reduce((max, cells) => Math.max(max, cells[i]?.length ?? 0), column.header.length),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padStart(widths[i] ?? 0)).join('  ');
  return [line(columns.map((column) => column.header)), ...body.map(line)];
}

function printSummary(primary: Aggregate, all: Aggregate | undefined, sender: Address | undefined): void {
  const s = primary.summary;
  const row = (label: string, value: string) => console.log(`${label.padEnd(22)} ${value}`);

  row('blocks in range', `${s.blocksInRange}`);
  row('blocks with activity', `${s.activeBlocks}`);
  row('seconds spanned', `${s.spanSeconds}  (last ts - first ts; >=1 s granularity)`);
  row('blocks/second', `${s.blocksPerSecond.toFixed(2)}  observed`);
  row('userOps', `${s.userOps}  (ok ${s.userOpsOk} / fail ${s.userOpsFail})${sender ? `  sender ${sender}` : ''}`);
  if (all) row('  all senders', `${all.summary.userOps}  (ok ${all.summary.userOpsOk} / fail ${all.summary.userOpsFail})`);
  row('bundles', `${s.bundles}  avg ${s.avgOpsPerBundle.toFixed(2)} ops/bundle, max ${s.maxOpsInBundle} in one bundle`);
  if (all) row('  all senders', `${all.summary.bundles}`);
  if (s.revertedBundles > 0) {
    row('  reverted bundles', `${s.revertedBundles}  (unexpected: a reverted handleOps emits no UserOperationEvent)`);
  }
  row('outer gas / bundle', `${fmtGas(s.avgOuterGasPerBundle)}  (bundle receipt gasUsed)`);
  row('outer gas / userOp', `${fmtGas(s.avgOuterGasPerOp)}  (sum of bundle receipt gasUsed / ops)`);
  if (all) {
    // Filtered bundles may carry other senders' ops, whose gas then lands on this sender's per-op figure.
    const allOps = new Map(all.bundles.map((bundle) => [bundle.hash, bundle.ops] as const));
    const foreign = primary.bundles.reduce(
      (sum, bundle) => sum + (allOps.get(bundle.hash) ?? bundle.ops) - bundle.ops,
      0,
    );
    if (foreign > 0) row('  caveat', `${foreign} op(s) from other senders share these bundles; per-op outer gas is overstated`);
  }
  row('actualGasUsed / op', `${fmtGas(s.avgActualGasUsedPerOp)}  (from UserOperationEvent)`);
  if (s.placed) {
    row('placed', `${s.placed.total}  (lanes ${s.placed.lanes} / direct ${s.placed.direct})`);
    if (all?.summary.placed) {
      row('  all traders', `${all.summary.placed.total}  (lanes ${all.summary.placed.lanes} / direct ${all.summary.placed.direct})`);
    }
  }
  row('ops/second', `${s.opsPerSecond.toFixed(2)}  chain-side, over the span`);
  row('peak ops / block', s.peakBlock?.ops ? `${s.peakBlock.ops}  (block ${s.peakBlock.number})` : '0');
  row(
    'peak ops / second',
    s.peakSecond?.ops
      ? `${s.peakSecond.ops}  (ts ${s.peakSecond.timestamp}, ${s.peakSecond.blocks} block(s))`
      : '0',
  );
  row(
    'gas utilisation',
    `avg ${s.gas.avgUtilisationPercent.toFixed(1)}%, max ${s.gas.maxUtilisationPercent.toFixed(1)}% of gasLimit ${fmtInt(s.gas.limit)}; ` +
      `${s.gas.fullBlocks} block(s) >=${FULL_BLOCK_PERCENT}% full`,
  );
  row('relayers', `${s.relayers.length} distinct bundle sender(s)`);
  for (const relayer of s.relayers) row('', relayer);
  row(
    'ceiling (this shape)',
    s.ceiling
      ? `~${s.ceiling.opsPerBlock.toFixed(0)} ops/block (gasLimit / outer gas per op)  ->  ` +
          `~${s.ceiling.opsPerSecond.toFixed(1)} ops/second at ${s.blocksPerSecond.toFixed(2)} blocks/s`
      : 'n/a (no userOps in range)',
  );
}

function toJson(
  settings: Settings,
  range: Range,
  context: Context,
  primary: Aggregate,
  all: Aggregate | undefined,
): unknown {
  return {
    chain: { id: chain.id, name: chain.name },
    rpc: displayRpcUrl(),
    head: range.head,
    range: {
      fromBlock: range.from,
      toBlock: range.to,
      blocks: context.blocks.length,
      padBlocks: settings.padBlocks,
      source: range.source,
      clampedToHead: range.clampedToHead,
    },
    entryPoint: settings.entryPoint,
    venue: settings.venue ?? null,
    senderFilter: settings.sender ?? null,
    blocks: primary.rows.map((row) => ({
      number: row.block.number,
      timestamp: row.block.timestamp,
      offsetSeconds: row.offsetSeconds,
      txs: row.block.txCount,
      gasUsed: row.block.gasUsed,
      gasLimit: row.block.gasLimit,
      gasUsedPercent: percentOf(row.block.gasUsed, row.block.gasLimit),
      bundles: row.bundles.size,
      userOpsOk: row.userOpsOk,
      userOpsFail: row.userOpsFail,
      placedLanes: context.hasVenue ? row.placedLanes : null,
      placedDirect: context.hasVenue ? row.placedDirect : null,
    })),
    bundles: primary.bundles,
    summary: primary.summary,
    /** Unfiltered figures, present only when REPORT_SENDER narrowed `summary`. */
    allSenders: all?.summary ?? null,
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function percentOf(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number((part * 10_000n) / whole) / 100;
}

const integerFormat = new Intl.NumberFormat('en-US');

function fmtInt(value: bigint | number): string {
  return integerFormat.format(value);
}

function fmtGas(value: bigint | null): string {
  return value === null ? 'n/a' : fmtInt(value);
}

/** viem's full messages embed the RPC URL, which may carry a key, so keep to the short form. */
function describeError(error: unknown): string {
  if (error instanceof BaseError) return `${error.name}: ${error.shortMessage}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

main().catch((error: unknown) => {
  console.error(`block-report failed: ${describeError(error)}`);
  process.exitCode = 1;
});
