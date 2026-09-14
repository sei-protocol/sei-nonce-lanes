import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, formatEther, formatGwei, formatUnits, type Hex } from 'viem';
import { accountAbi, entryPointAbi, venueAbi } from '../src/abi.js';
import { currentDelegation } from '../src/delegation.js';
import {
  ENTRY_POINT,
  assertPlainRelayers,
  assertWriteNetwork,
  chain,
  config,
  displayRpcUrl,
  explorerTx,
  laneAccountImpl,
  publicClient,
  relayerAccounts,
  rpcUrl,
  senderRunLockPath,
  trader,
  venueAddress,
} from '../src/env.js';
import { OperationJournal } from '../src/journal.js';
import { LanePool } from '../src/lanes.js';
import { BundlingQueue, type PendingOp } from '../src/bundling-queue.js';
import { RelayerPool, type BundleResult } from '../src/relayers.js';
import { SenderRunLock } from '../src/run-lock.js';
import { buildOp, signUserOp, userOpHash } from '../src/userop.js';

/**
 * Throughput benchmark for nonce lanes: `src/submit.ts` with the per-order
 * reporting removed and the run measured instead.
 *
 * The safety path is the tutorial's, unchanged: same preflight, sender-wide
 * lock, write-ahead journal, restart reconciliation, and the one deliberately
 * reverting order. What differs is bookkeeping. Outcomes come from the
 * `UserOperationEvent`s already parsed out of each bundle receipt, so a run of
 * thousands of orders adds no per-order RPC reads, and each run appends one
 * JSON line to a results file so configurations can be compared afterwards.
 *
 * Run shape comes from the usual knobs (ORDERS, LANE_POOL_SIZE, MAX_OPS_PER_BUNDLE,
 * RELAYER_COUNT, REVERT_ORDER_INDEX); the shell environment overrides `.env`:
 *
 *   ORDERS=512 LANE_POOL_SIZE=512 MAX_OPS_PER_BUNDLE=16 RELAYER_COUNT=8 \
 *     BENCH_LABEL="16x8" npx tsx bench/lanes-tps.ts
 *
 * Benchmark-only knobs: BENCH_LABEL, BENCH_RESULTS_PATH, BENCH_OPERATION_JOURNAL_PATH.
 */

const benchDir = dirname(fileURLToPath(import.meta.url));
/** Separate from the tutorial journal so a benchmark never replays or blocks `npm run submit`. */
const benchOperationJournalPath =
  process.env.BENCH_OPERATION_JOURNAL_PATH?.trim() ||
  resolve(benchDir, '../.state/bench/pending-lanes-bench.json');
const benchResultsPath =
  process.env.BENCH_RESULTS_PATH?.trim() || resolve(benchDir, '../.state/bench/lanes-results.jsonl');
const benchLabel = process.env.BENCH_LABEL?.trim() ?? '';

/**
 * Order ids must be unique per venue and a benchmark places thousands per run,
 * so the stride is wider than the tutorial's 1000: two runs one millisecond
 * apart still cannot collide.
 */
const ORDER_ID_STRIDE = 100_000n;

let activeJournal: OperationJournal | undefined;
let activeSenderLock: SenderRunLock | undefined;

async function main() {
  const startedAt = Date.now();
  const configuredVenue = venueAddress;
  const configuredImplementation = laneAccountImpl;
  if (!configuredVenue) throw new Error('Set VENUE in .env');
  if (!configuredImplementation) throw new Error('Set LANE_ACCOUNT_IMPL in .env');

  /* ------------------------------- preflight ------------------------------- */

  await assertWriteNetwork('bench:lanes');
  await assertPlainRelayers('bench:lanes');
  activeSenderLock = await SenderRunLock.acquire(senderRunLockPath);
  console.log('=== bench preflight ===');
  console.log(`chain          ${chain.name} (${chain.id})`);
  console.log(`rpc            ${displayRpcUrl()}`);
  if (benchLabel) console.log(`label          ${benchLabel}`);
  console.log(
    `run shape      ${config.orders} orders, ${config.lanePoolSize} lanes, ` +
      `<=${config.maxOpsPerBundle} ops/bundle, ${relayerAccounts.length} relayers, ` +
      `revert index ${config.revertOrderIndex}`,
  );

  const [entryPointCode, implementationCode, venueCode] = await Promise.all([
    publicClient.getCode({ address: ENTRY_POINT }),
    publicClient.getCode({ address: configuredImplementation }),
    publicClient.getCode({ address: configuredVenue }),
  ]);
  if (!entryPointCode) throw new Error(`No EntryPoint at ${ENTRY_POINT} on this chain`);
  if (!implementationCode) {
    throw new Error(`LANE_ACCOUNT_IMPL ${configuredImplementation} has no code`);
  }
  if (!venueCode) throw new Error(`VENUE ${configuredVenue} has no code`);
  console.log(`entryPoint     ${ENTRY_POINT} (${(entryPointCode.length - 2) / 2} bytes)`);

  const delegation = await currentDelegation();
  if (!delegation) throw new Error('Trading account is not delegated. Run: npm run delegate');
  if (delegation.toLowerCase() !== configuredImplementation.toLowerCase()) {
    throw new Error(
      `Delegation mismatch: trader delegates to ${delegation}, but LANE_ACCOUNT_IMPL is ${configuredImplementation}`,
    );
  }
  console.log(`trader         ${trader.address}`);
  console.log(`delegated to   ${delegation}`);

  const [markPx, depositBefore, traderBalance, nonceBefore, latestBlock] = await Promise.all([
    publicClient.readContract({ address: configuredVenue, abi: venueAbi, functionName: 'markPx' }),
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.getBalance({ address: trader.address }),
    publicClient.getTransactionCount({ address: trader.address }),
    publicClient.getBlock(),
  ]);
  const blockGasLimit = latestBlock.gasLimit;

  console.log(`venue          ${configuredVenue}  mark ${formatUnits(markPx, 18)}`);
  console.log(`trader balance ${formatEther(traderBalance)} SEI`);
  console.log(`ep deposit     ${formatEther(depositBefore)} SEI`);
  console.log(`trader nonce   ${nonceBefore}  <- watch this, it must not move`);
  console.log(`block          ${latestBlock.number}, gas limit ${blockGasLimit}`);

  const journal = await OperationJournal.open(benchOperationJournalPath, {
    chainId: chain.id,
    entryPoint: ENTRY_POINT,
    sender: trader.address,
  });
  await journal.acquireLock();
  activeJournal = journal;
  console.log(`journal        ${journal.size} pending op(s)  ${benchOperationJournalPath}`);

  const relayerPoolStart = Date.now();
  const relayerPool = await RelayerPool.create(
    relayerAccounts,
    publicClient,
    chain,
    rpcUrl,
    ENTRY_POINT,
    {
      journal,
      receiptTimeoutMs: config.bundleReceiptTimeoutMs,
      maxAttempts: config.bundleMaxAttempts,
      feeBumpPercent: config.replacementFeeBumpPercent,
    },
  );
  const relayerPoolCreateMs = Date.now() - relayerPoolStart;
  // One line for the pool rather than one per relayer: a benchmark may run hundreds.
  let smallestRelayerBalance: bigint | undefined;
  for (const { address, balance } of await relayerPool.balances()) {
    if (balance === 0n) throw new Error(`Relayer ${address} has no gas. Run: npm run fund`);
    if (smallestRelayerBalance === undefined || balance < smallestRelayerBalance) {
      smallestRelayerBalance = balance;
    }
  }
  console.log(
    `relayers       ${relayerAccounts.length} gas-only accounts, smallest balance ` +
      `${formatEther(smallestRelayerBalance ?? 0n)} SEI, pool ready in ${relayerPoolCreateMs}ms`,
  );

  /* --------------------------------- build --------------------------------- */

  console.log('\n=== build ===');
  const fees = await publicClient.estimateFeesPerGas();
  // Headroom, so the relayer is not paying more for gas than the signed op covers.
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;
  console.log(
    `fees           maxFee ${formatGwei(maxFeePerGas)} gwei, ` +
      `priority ${formatGwei(maxPriorityFeePerGas)} gwei (2x estimate)`,
  );

  // Estimate the delegated account's complete execution path on this chain.
  // Sei charges materially more than Ethereum for these storage writes, so a
  // static Ethereum-sized call limit can make every otherwise-valid op run OOG.
  const runId = BigInt(Date.now());
  const probeVenueCall = encodeFunctionData({
    abi: venueAbi,
    functionName: 'place',
    args: [runId * ORDER_ID_STRIDE + BigInt(config.orders + 1), 10n ** 18n, markPx],
  });
  const probeAccountCall = encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [configuredVenue, 0n, probeVenueCall],
  });
  const estimatedCallGas = await publicClient.estimateGas({
    account: ENTRY_POINT,
    to: trader.address,
    data: probeAccountCall,
  });
  const recommendedCallGas = (estimatedCallGas * 125n + 99n) / 100n;
  const configuredCallGas = config.callGasLimit;
  const callGasLimit =
    configuredCallGas !== undefined && configuredCallGas > recommendedCallGas
      ? configuredCallGas
      : recommendedCallGas;
  console.log(
    `call gas       ${callGasLimit} (estimate ${estimatedCallGas}` +
      `${configuredCallGas === undefined ? '' : `, CALL_GAS_LIMIT floor ${configuredCallGas}`})`,
  );

  const lanePoolStart = Date.now();
  const lanePool = await LanePool.create(publicClient, ENTRY_POINT, trader.address, config.lanePoolSize);
  const lanePoolCreateMs = Date.now() - lanePoolStart;
  console.log(
    `lane pool      ${config.lanePoolSize} lanes, ${lanePool.idleCount} idle, ` +
      `sequences read in ${lanePoolCreateMs}ms`,
  );

  const durableRunOps = journal.runOps();
  const pendingAtStartup = journal.allOps();
  const pendingAtStartupHashes = new Set(pendingAtStartup.map((pending) => pending.hash));
  const knownConsumed = new Set<Hex>(
    durableRunOps
      .filter((pending) => !pendingAtStartupHashes.has(pending.hash))
      .map((pending) => pending.hash),
  );
  // Work inherited from an earlier process is still finished correctly, but its
  // timings belong to two runs, so the record flags it for anyone comparing numbers.
  const resumed = durableRunOps.length > 0;
  if (resumed) {
    console.log(`resumed        ${durableRunOps.length} op(s) from an earlier process; not a clean benchmark`);
  }

  // Reconcile the durable queue before signing anything new. If a prior outer
  // transaction landed just before a crash, its advanced lane nonce is the
  // authoritative completion signal.
  const alreadyConsumed: PendingOp[] = [];
  for (const pending of pendingAtStartup) {
    const current = lanePool.sequence(pending.lane);
    if (current === undefined) throw new Error(`journal lane ${pending.lane} is outside the pool`);
    if (current > pending.seq) {
      alreadyConsumed.push(pending);
      knownConsumed.add(pending.hash);
      continue;
    }
    if (current < pending.seq) {
      throw new Error(`journal lane ${pending.lane} expects seq ${pending.seq}, chain is at ${current}`);
    }
    lanePool.reserve(pending.lane, pending.seq);
  }
  if (alreadyConsumed.length > 0) {
    await journal.complete(alreadyConsumed);
    console.log(`reconciled     ${alreadyConsumed.length} op(s) already consumed on chain`);
  }

  const completedRecoveryResults: BundleResult[] = [];
  let recoveryMs = 0;
  const recoveryGroups = journal.recoveryBundles();
  if (recoveryGroups.length > 0) {
    const recoveryStart = Date.now();
    console.log(`recovering     ${recoveryGroups.length} interrupted bundle(s)`);
    const recoveredResults = await relayerPool.recover(recoveryGroups, async (result) => {
      if (result.mined) {
        for (const pending of result.ops) lanePool.settle(pending.lane, true);
        await journal.complete(result.ops);
      } else if (!result.pending) {
        // Its outer nonce is definitively clear/consumed and no lane advanced.
        // Keep the signed UserOps queued, but discard stale outer transactions.
        await journal.clearAttempts(result.ops);
      }
    });
    completedRecoveryResults.push(...recoveredResults.filter((result) => result.mined));
    const unresolved = recoveredResults.filter((result) => result.pending);
    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.length} interrupted bundle(s) remain ambiguous; refusing to create duplicate work`,
      );
    }
    recoveryMs = Date.now() - recoveryStart;
  }

  const bundlingQueue = new BundlingQueue();
  const built: PendingOp[] = [...durableRunOps];
  const queued = journal.queuedOps();
  for (const pending of queued) {
    bundlingQueue.add(pending);
  }
  if (queued.length > 0) console.log(`requeued       ${queued.length} durable pending op(s)`);

  const ordersToBuild = Math.min(Math.max(config.orders - built.length, 0), lanePool.idleCount);

  // Signing is the point of no return for these lanes, so re-check that this
  // process still owns the sender rather than trusting the earlier acquisition.
  await activeSenderLock?.assertHeld();

  const signStart = Date.now();
  const pendings = await Promise.all(
    Array.from({ length: ordersToBuild }, async (_, i) => {
      const slot = lanePool.acquire();
      if (!slot) throw new Error(`lane pool exhausted at order ${i}; raise LANE_POOL_SIZE`);

      const orderIndex = built.length + i;
      const shouldRevert = orderIndex === config.revertOrderIndex;
      // A limit price under the mark makes the venue revert with Slippage, which is
      // the realistic "this one op fails" case.
      const limitPx = shouldRevert ? markPx - 1n : markPx;
      const orderId = runId * ORDER_ID_STRIDE + BigInt(orderIndex);

      const unsigned = buildOp({
        sender: trader.address,
        lane: slot.lane,
        seq: slot.seq,
        target: configuredVenue,
        data: encodeFunctionData({
          abi: venueAbi,
          functionName: 'place',
          args: [orderId, 10n ** 18n, limitPx],
        }),
        verificationGasLimit: config.verificationGasLimit,
        callGasLimit,
        preVerificationGas: config.preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });

      const op = await signUserOp(trader, unsigned, chain.id, ENTRY_POINT);
      return {
        op,
        hash: userOpHash(op, chain.id, ENTRY_POINT),
        lane: slot.lane,
        seq: slot.seq,
        orderId,
        label: shouldRevert ? 'expected revert (limit under mark)' : '',
      } satisfies PendingOp;
    }),
  );
  const signMs = Date.now() - signStart;

  await journal.add(pendings);
  for (const pending of pendings) {
    built.push(pending);
    bundlingQueue.add(pending);
  }
  console.log(`signed         ${pendings.length} new ops in ${signMs}ms, without nonce RPCs`);

  // Cross-check the locally computed EIP-712 digest against the EntryPoint itself.
  // If this passes, the client-side hashing matches consensus exactly.
  if (built.length > 0) {
    const onChainHash = await publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'getUserOpHash',
      args: [built[0]!.op],
    });
    if (onChainHash !== built[0]!.hash) {
      throw new Error(`userOpHash mismatch: local ${built[0]!.hash} vs chain ${onChainHash}`);
    }
    console.log(`hash check     local digest matches EntryPoint.getUserOpHash`);
  }

  /* -------------------------------- submit -------------------------------- */

  console.log('\n=== submit ===');
  const queuedOps = bundlingQueue.size;
  const expectedBundles = Math.ceil(queuedOps / config.maxOpsPerBundle);
  console.log(
    `${queuedOps} ops -> ${expectedBundles} bundle(s) of <=${config.maxOpsPerBundle} -> ` +
      `${relayerAccounts.length} relayers\n`,
  );

  let settledBundles = 0;
  const submitStart = Date.now();
  const submittedResults = await relayerPool.drain(bundlingQueue, config.maxOpsPerBundle, async (result) => {
    if (result.mined) {
      // A successful handleOps consumes every lane, including execution reverts.
      for (const pending of result.ops) lanePool.settle(pending.lane, true);
      await journal.complete(result.ops);
    } else if (!result.pending) {
      // No lane was consumed and no same-nonce outer transaction can still land.
      for (const pending of result.ops) lanePool.settle(pending.lane, false);
      await journal.clearAttempts(result.ops);
    }

    // Progress, not a per-bundle log: thousands of lines would bury the summary.
    settledBundles += 1;
    if (
      expectedBundles <= 20 ||
      settledBundles % 25 === 0 ||
      settledBundles === expectedBundles ||
      !result.mined
    ) {
      const where =
        result.blockNumber !== undefined
          ? `block ${result.blockNumber}`
          : result.pending
            ? 'pending recovery'
            : 'failed';
      console.log(
        `  ${String(settledBundles).padStart(String(expectedBundles).length)}/${expectedBundles}  ` +
          `${result.mined ? 'mined  ' : result.pending ? 'PENDING' : 'FAILED '}  ${where}` +
          `  ${result.ops.length} op(s)` +
          (result.gasUsed === undefined ? '' : `  gas ${result.gasUsed}`) +
          `  +${Date.now() - submitStart}ms` +
          (result.mined || result.error === undefined ? '' : `  ${result.error}`),
      );
    }
  });
  const results = [...completedRecoveryResults, ...submittedResults];
  await journal.flush();
  const submitMs = recoveryMs + (Date.now() - submitStart);

  /* -------------------------------- report -------------------------------- */

  // Outcomes come from the UserOperationEvents in each bundle receipt. No
  // per-order venue reads: at benchmark sizes those would burst the RPC.
  const outcomeByHash = new Map<Hex, boolean>();
  for (const result of results) {
    for (const [hash, ok] of result.opSuccess) outcomeByHash.set(hash, ok);
  }
  const landedHashes = new Set<Hex>(knownConsumed);
  for (const result of results) {
    if (result.mined) for (const pending of result.ops) landedHashes.add(pending.hash);
  }
  const landed = built.filter((pending) => landedHashes.has(pending.hash));
  const executedOk = built.filter((pending) => outcomeByHash.get(pending.hash) === true);
  const reverted = built.filter((pending) => outcomeByHash.get(pending.hash) === false);
  // Consumed per the lane nonce, or in an earlier process, so no receipt was parsed.
  const outcomeUnknown = landed.filter((pending) => !outcomeByHash.has(pending.hash));
  const expectedReverts = built.filter((pending) => pending.label.includes('expected revert'));
  const unexpectedReverts = reverted.filter((pending) => !pending.label.includes('expected revert'));

  const minedBundles = results.filter((result) => result.mined);
  const pendingBundles = results.filter((result) => result.pending);
  const failedBundles = results.filter((result) => !result.mined && !result.pending);
  // A bundle reconciled through lane nonces alone has no receipt, hence no gas figure.
  const minedWithGas = minedBundles.filter(
    (result): result is BundleResult & { gasUsed: bigint } => result.gasUsed !== undefined,
  );
  const gasUsedTotal = minedWithGas.reduce((sum, result) => sum + result.gasUsed, 0n);
  const opsWithGas = minedWithGas.reduce((sum, result) => sum + result.ops.length, 0);
  const avgGasPerBundle = minedWithGas.length > 0 ? gasUsedTotal / BigInt(minedWithGas.length) : null;
  const avgGasPerLandedOp = opsWithGas > 0 ? gasUsedTotal / BigInt(opsWithGas) : null;

  const blockNumbers = minedBundles
    .map((result) => result.blockNumber)
    .filter((blockNumber): blockNumber is bigint => blockNumber !== undefined);
  const distinctBlocks = new Set(blockNumbers.map((blockNumber) => blockNumber.toString())).size;
  const firstBlock = blockNumbers.reduce<bigint | null>(
    (min, blockNumber) => (min === null || blockNumber < min ? blockNumber : min),
    null,
  );
  const lastBlock = blockNumbers.reduce<bigint | null>(
    (max, blockNumber) => (max === null || blockNumber > max ? blockNumber : max),
    null,
  );
  const relayersUsed = new Set(results.map((result) => result.relayer)).size;
  const landedOpsPerSecClient = landed.length / Math.max(submitMs / 1000, 0.001);

  const chainSpan =
    firstBlock !== null && lastBlock !== null
      ? await measureChainSpan(firstBlock, lastBlock, landed.length)
      : null;

  const [depositAfter, nonceAfter] = await Promise.all([
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.getTransactionCount({ address: trader.address }),
  ]);
  const depositSpent = depositBefore - depositAfter;
  const costPerOp = landed.length > 0 ? depositSpent / BigInt(landed.length) : null;
  const totalMs = Date.now() - startedAt;
  const firstBundleTx =
    results.find((result) => result.mined && result.txHash)?.txHash ??
    results.find((result) => result.txHash)?.txHash ??
    null;

  console.log('\n=== summary ===');
  if (benchLabel) console.log(`label                ${benchLabel}`);
  console.log(
    `run shape            ${config.orders} orders, ${config.lanePoolSize} lanes, ` +
      `<=${config.maxOpsPerBundle} ops/bundle, ${relayerAccounts.length} relayers`,
  );
  if (resumed) console.log(`resumed              yes, timings include an earlier process's work`);
  console.log(`ops submitted        ${built.length}`);
  console.log(`ops landed           ${landed.length}`);
  console.log(`  executed ok        ${executedOk.length}`);
  console.log(
    `  reverted on chain  ${reverted.length}  (${expectedReverts.length} expected, each consumed only its own lane)`,
  );
  if (outcomeUnknown.length > 0) {
    console.log(`  outcome unknown    ${outcomeUnknown.length}  (landed without a parsed receipt)`);
  }
  console.log(`bundles              ${results.length}`);
  console.log(
    `  mined              ${minedBundles.length} across ${distinctBlocks} block(s)` +
      (firstBlock === null ? '' : `  [${firstBlock}..${lastBlock}]`),
  );
  console.log(`  pending recovery   ${pendingBundles.length}`);
  console.log(`  failed safely      ${failedBundles.length}`);
  console.log(`journal pending      ${journal.size}`);
  console.log(`relayers used        ${relayersUsed} of ${relayerAccounts.length}`);
  console.log(
    `outer gas            ${gasUsedTotal} total, ${avgGasPerBundle ?? '-'} avg/bundle, ` +
      `${avgGasPerLandedOp ?? '-'} avg/landed op`,
  );
  console.log(
    `fees                 maxFee ${formatGwei(maxFeePerGas)} gwei, ` +
      `priority ${formatGwei(maxPriorityFeePerGas)} gwei`,
  );
  console.log(
    `gas limits           call ${callGasLimit}, verification ${config.verificationGasLimit}, ` +
      `preVerification ${config.preVerificationGas}, block ${blockGasLimit}`,
  );
  console.log(`startup              relayer pool ${relayerPoolCreateMs}ms, lane pool ${lanePoolCreateMs}ms`);
  console.log(`sign time            ${signMs}ms`);
  if (recoveryMs > 0) console.log(`recovery time        ${recoveryMs}ms`);
  console.log(`submit time          ${submitMs}ms`);
  console.log(`throughput (client)  ${landedOpsPerSecClient.toFixed(1)} landed ops/sec over submit time`);
  console.log(
    chainSpan === null
      ? `throughput (chain)   -  (no mined bundle)`
      : `throughput (chain)   ${chainSpan.landedOpsPerSec.toFixed(1)} landed ops/sec over ` +
          `${chainSpan.seconds}s of block timestamps (1s granularity on Sei, floored at 1s)`,
  );
  console.log(
    `ep deposit           ${formatEther(depositBefore)} -> ${formatEther(depositAfter)} SEI  ` +
      `(spent ${formatEther(depositSpent)}${costPerOp === null ? '' : `, ${formatEther(costPerOp)}/landed op`})`,
  );
  console.log(
    `trader EVM nonce     ${nonceBefore} -> ${nonceAfter}  ` +
      `${nonceBefore === nonceAfter ? 'UNCHANGED' : 'MOVED (unexpected)'}`,
  );
  console.log(`total wall time      ${totalMs}ms`);

  for (const pending of unexpectedReverts.slice(0, 10)) {
    console.log(`unexpected revert    lane ${pending.lane}  seq ${pending.seq}`);
  }
  if (unexpectedReverts.length > 10) {
    console.log(`unexpected revert    ... ${unexpectedReverts.length - 10} more`);
  }

  const reverting = expectedReverts[0];
  if (reverting && outcomeByHash.get(reverting.hash) === false && executedOk.length > 0) {
    console.log('');
    console.log(`The reverting order failed and its neighbors still landed. That is the`);
    console.log(`property you wanted: nothing queues behind a failure.`);
  }

  // Recorded before any failure is raised, so an incomplete run is still comparable.
  await appendResult(benchResultsPath, {
    timestamp: new Date(startedAt).toISOString(),
    label: benchLabel,
    chainId: chain.id,
    rpc: displayRpcUrl(),
    resumed,
    orders: config.orders,
    lanePoolSize: config.lanePoolSize,
    maxOpsPerBundle: config.maxOpsPerBundle,
    relayerCount: relayerAccounts.length,
    revertOrderIndex: config.revertOrderIndex,
    callGasLimit,
    verificationGasLimit: config.verificationGasLimit,
    preVerificationGas: config.preVerificationGas,
    maxFeePerGasWei: maxFeePerGas,
    maxFeePerGasGwei: formatGwei(maxFeePerGas),
    maxPriorityFeePerGasWei: maxPriorityFeePerGas,
    maxPriorityFeePerGasGwei: formatGwei(maxPriorityFeePerGas),
    blockGasLimit,
    relayerPoolCreateMs,
    lanePoolCreateMs,
    signMs,
    recoveryMs,
    submitMs,
    totalMs,
    opsSubmitted: built.length,
    opsLanded: landed.length,
    opsExecutedOk: executedOk.length,
    opsReverted: reverted.length,
    opsOutcomeUnknown: outcomeUnknown.length,
    unexpectedReverts: unexpectedReverts.length,
    bundlesMined: minedBundles.length,
    bundlesPending: pendingBundles.length,
    bundlesFailed: failedBundles.length,
    blocks: distinctBlocks,
    firstBlock,
    lastBlock,
    chainSpanSeconds: chainSpan?.seconds ?? null,
    relayersUsed,
    gasUsedTotal,
    avgGasPerBundle,
    avgGasPerLandedOp,
    landedOpsPerSecClient: roundRate(landedOpsPerSecClient),
    landedOpsPerSecChain: chainSpan === null ? null : roundRate(chainSpan.landedOpsPerSec),
    depositBeforeWei: depositBefore,
    depositAfterWei: depositAfter,
    depositSpentSei: formatEther(depositSpent),
    costPerOpSei: costPerOp === null ? null : formatEther(costPerOp),
    traderNonceBefore: nonceBefore,
    traderNonceAfter: nonceAfter,
    firstBundleTx,
    firstBundleExplorer: firstBundleTx === null ? null : explorerTx(firstBundleTx),
  });
  console.log(`results              ${benchResultsPath} (+1 line)`);
  if (firstBundleTx) console.log(`example bundle       ${explorerTx(firstBundleTx)}`);

  if (pendingBundles.length > 0 || failedBundles.length > 0) {
    throw new Error(`${pendingBundles.length + failedBundles.length} bundle(s) require recovery`);
  }
  if (nonceBefore !== nonceAfter) throw new Error('Trader EVM nonce moved during the benchmark');

  await journal.finishRun();
}

/**
 * Sei stamps blocks in whole seconds while producing several per second, so
 * the timestamp span of the first and last landing block is a floor, and a run
 * that fits inside one second reads as one. It is the conservative rate: it
 * depends only on consensus data, not on this client's clock or RPC latency.
 */
async function measureChainSpan(
  firstBlock: bigint,
  lastBlock: bigint,
  landedOps: number,
): Promise<{ seconds: number; landedOpsPerSec: number }> {
  const [first, last] = await Promise.all([
    publicClient.getBlock({ blockNumber: firstBlock }),
    firstBlock === lastBlock ? undefined : publicClient.getBlock({ blockNumber: lastBlock }),
  ]);
  const seconds = Number((last ?? first).timestamp - first.timestamp);
  return { seconds, landedOpsPerSec: landedOps / Math.max(seconds, 1) };
}

/** One JSON object per line, bigints as decimal strings, appended so runs accumulate. */
async function appendResult(path: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record, stringifyBigInt) + '\n', 'utf8');
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await activeJournal?.flush();
      await activeJournal?.releaseLock();
    } catch (error) {
      console.error(`failed to release bench journal lock: ${String(error)}`);
      process.exitCode = 1;
    }
    try {
      await activeSenderLock?.release();
    } catch (error) {
      console.error(`failed to release sender-wide run lock: ${String(error)}`);
      process.exitCode = 1;
    }
  });
