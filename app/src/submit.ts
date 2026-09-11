import { encodeFunctionData, formatEther, formatUnits, type Hex } from 'viem';
import { accountAbi, entryPointAbi, venueAbi } from './abi.js';
import { currentDelegation } from './delegation.js';
import {
  ENTRY_POINT,
  assertPlainRelayers,
  assertWriteNetwork,
  chain,
  config,
  displayRpcUrl,
  explorerTx,
  laneAccountImpl,
  operationJournalPath,
  publicClient,
  relayerAccounts,
  rpcUrl,
  senderRunLockPath,
  trader,
  venueAddress,
} from './env.js';
import { OperationJournal } from './journal.js';
import { LanePool } from './lanes.js';
import { BundlingQueue, type PendingOp } from './bundling-queue.js';
import { RelayerPool, type BundleResult } from './relayers.js';
import { SenderRunLock } from './run-lock.js';
import { buildOp, signUserOp, userOpHash } from './userop.js';

let activeJournal: OperationJournal | undefined;
let activeSenderLock: SenderRunLock | undefined;

async function main() {
  const startedAt = Date.now();
  const configuredVenue = venueAddress;
  const configuredImplementation = laneAccountImpl;
  if (!configuredVenue) throw new Error('Set VENUE in .env');
  if (!configuredImplementation) throw new Error('Set LANE_ACCOUNT_IMPL in .env');

  /* ------------------------------- preflight ------------------------------- */

  await assertWriteNetwork('submit');
  await assertPlainRelayers('submit');
  activeSenderLock = await SenderRunLock.acquire(senderRunLockPath);
  console.log('=== preflight ===');
  console.log(`chain          ${chain.name} (${chain.id})`);
  console.log(`rpc            ${displayRpcUrl()}`);

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

  const [markPx, deposit, traderBalance, nonceBefore] = await Promise.all([
    publicClient.readContract({ address: configuredVenue, abi: venueAbi, functionName: 'markPx' }),
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.getBalance({ address: trader.address }),
    publicClient.getTransactionCount({ address: trader.address }),
  ]);

  console.log(`venue          ${configuredVenue}  mark ${formatUnits(markPx, 18)}`);
  console.log(`trader balance ${formatEther(traderBalance)} SEI`);
  console.log(`ep deposit     ${formatEther(deposit)} SEI`);
  console.log(`trader nonce   ${nonceBefore}  <- watch this, it must not move`);

  const journal = await OperationJournal.open(operationJournalPath, {
    chainId: chain.id,
    entryPoint: ENTRY_POINT,
    sender: trader.address,
  });
  await journal.acquireLock();
  activeJournal = journal;
  console.log(`journal        ${journal.size} pending op(s)`);

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
  for (const { address, balance } of await relayerPool.balances()) {
    if (balance === 0n) throw new Error(`Relayer ${address} has no gas. Run: npm run fund`);
    console.log(`relayer        ${address}  ${formatEther(balance)} SEI`);
  }

  /* --------------------------------- build --------------------------------- */

  console.log('\n=== build ===');
  const fees = await publicClient.estimateFeesPerGas();
  // Headroom, so the relayer is not paying more for gas than the signed op covers.
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  // Estimate the delegated account's complete execution path on this chain.
  // Sei charges materially more than Ethereum for these storage writes, so a
  // static Ethereum-sized call limit can make every otherwise-valid op run OOG.
  const runId = BigInt(Date.now());
  const probeVenueCall = encodeFunctionData({
    abi: venueAbi,
    functionName: 'place',
    args: [runId * 1000n + BigInt(config.orders + 1), 10n ** 18n, markPx],
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
  const callGasLimit =
    config.callGasLimit > recommendedCallGas ? config.callGasLimit : recommendedCallGas;
  console.log(
    `call gas       ${callGasLimit} (estimate ${estimatedCallGas}, configured ${config.callGasLimit})`,
  );

  const lanePool = await LanePool.create(publicClient, ENTRY_POINT, trader.address, config.lanePoolSize);
  console.log(`lane pool      ${config.lanePoolSize} lanes, ${lanePool.idleCount} idle`);

  const durableRunOps = journal.runOps();
  const pendingAtStartup = journal.allOps();
  const pendingAtStartupHashes = new Set(pendingAtStartup.map((pending) => pending.hash));
  const knownConsumed = new Set<Hex>(
    durableRunOps
      .filter((pending) => !pendingAtStartupHashes.has(pending.hash))
      .map((pending) => pending.hash),
  );

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
  const recoveryGroups = journal.recoveryBundles();
  if (recoveryGroups.length > 0) {
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
  }

  const bundlingQueue = new BundlingQueue();
  const built: PendingOp[] = [...durableRunOps];
  const queued = journal.queuedOps();
  for (const pending of queued) {
    bundlingQueue.add(pending);
  }
  if (queued.length > 0) console.log(`requeued       ${queued.length} durable pending op(s)`);

  const ordersToBuild = Math.min(Math.max(config.orders - built.length, 0), lanePool.idleCount);

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
      const orderId = runId * 1000n + BigInt(orderIndex);

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
  console.log(`${built.length} ops -> bundles of <=${config.maxOpsPerBundle} -> ${relayerAccounts.length} relayers\n`);

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

    const where =
      result.blockNumber !== undefined
        ? `block ${result.blockNumber}`
        : result.pending
          ? 'pending recovery'
          : (result.error ?? 'failed');
    const lanes = result.ops.map((o) => o.lane).join(',');
    console.log(
      `  ${result.mined ? 'mined  ' : result.pending ? 'PENDING' : 'FAILED '} lanes [${lanes}]  ${where}` +
        (result.txHash ? `  gas ${result.gasUsed}` : ''),
    );
  });
  const results = [...completedRecoveryResults, ...submittedResults];
  await journal.flush();
  const submitMs = Date.now() - submitStart;

  /* -------------------------------- report -------------------------------- */

  console.log('\n=== per-order outcome ===');
  const byHash = new Map(results.flatMap((r) => [...r.opSuccess].map(([h, ok]) => [h, { r, ok }] as const)));
  const landedHashes = new Set<Hex>(knownConsumed);
  for (const result of results) {
    if (result.mined) {
      for (const pending of result.ops) landedHashes.add(pending.hash);
    }
  }

  const filled = await Promise.all(
    built.map((pending) =>
      publicClient.readContract({
        address: configuredVenue,
        abi: venueAbi,
        functionName: 'isFilled',
        args: [pending.orderId],
      }),
    ),
  );
  const landingSeqs = await Promise.all(
    built.map((pending) =>
      publicClient.readContract({
        address: configuredVenue,
        abi: venueAbi,
        functionName: 'landingSeq',
        args: [pending.orderId],
      }),
    ),
  );

  console.log('  #  lane  seq  exec      filled  land#  block     note');
  built.forEach((pending, i) => {
    const outcome = byHash.get(pending.hash);
    const landed = landedHashes.has(pending.hash);
    const exec = !landed ? 'not mined' : filled[i] ? 'ok       ' : 'reverted ';
    const block = outcome?.r.blockNumber?.toString() ?? '-';
    console.log(
      `  ${String(i).padStart(2)}  ${String(pending.lane).padStart(4)}  ${String(pending.seq).padStart(3)}  ` +
        `${exec}  ${filled[i] ? '  yes ' : '  no  '}  ${String(landingSeqs[i]).padStart(5)}  ${block.padStart(8)}  ${pending.label}`,
    );
  });

  const minedOps = built.filter((pending) => landedHashes.has(pending.hash));
  const succeeded = built.filter((pending, i) => landedHashes.has(pending.hash) && filled[i]);
  const reverted = built.filter((pending, i) => landedHashes.has(pending.hash) && !filled[i]);
  const pendingBundles = results.filter((result) => result.pending);
  const failedBundles = results.filter((result) => !result.mined && !result.pending);
  const blocks = new Set(
    results
      .filter((result) => result.blockNumber !== undefined)
      .map((result) => result.blockNumber!.toString()),
  );
  const nonceAfter = await publicClient.getTransactionCount({ address: trader.address });

  console.log('\n=== summary ===');
  console.log(`ops submitted        ${built.length}`);
  console.log(`ops landed           ${minedOps.length}`);
  console.log(`  executed ok        ${succeeded.length}`);
  console.log(`  reverted on chain  ${reverted.length}  (each consumed only its own lane)`);
  console.log(`bundles              ${results.length} across ${blocks.size} block(s)`);
  console.log(`  pending recovery   ${pendingBundles.length}`);
  console.log(`  failed safely      ${failedBundles.length}`);
  console.log(`journal pending      ${journal.size}`);
  console.log(`distinct lanes       ${new Set(built.map((p) => p.lane.toString())).size}`);
  console.log(`relayers used        ${new Set(results.map((r) => r.relayer)).size}`);
  console.log(`sign time            ${signMs}ms`);
  console.log(`submit time          ${submitMs}ms`);
  console.log(`throughput           ${(minedOps.length / (submitMs / 1000)).toFixed(1)} landed ops/sec`);
  console.log('');
  console.log(`trader EVM nonce     ${nonceBefore} -> ${nonceAfter}  ${nonceBefore === nonceAfter ? 'UNCHANGED' : 'MOVED (unexpected)'}`);
  console.log(`total wall time      ${Date.now() - startedAt}ms`);

  const reverting = built.find((pending) => pending.label.includes('expected revert'));
  if (
    reverting &&
    landedHashes.has(reverting.hash) &&
    !filled[built.indexOf(reverting)] &&
    succeeded.length > 0
  ) {
    console.log('');
    console.log(`The reverting order failed and its neighbors still landed. That is the`);
    console.log(`property you wanted: nothing queues behind a failure.`);
  }

  const firstTx = results.find((r) => r.txHash)?.txHash;
  if (firstTx) console.log(`\nexample bundle: ${explorerTx(firstTx)}`);

  if (pendingBundles.length > 0 || failedBundles.length > 0) {
    throw new Error(`${pendingBundles.length + failedBundles.length} bundle(s) require recovery`);
  }

  await journal.finishRun();
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
      console.error(`failed to release operation journal lock: ${String(error)}`);
      process.exitCode = 1;
    }
    try {
      await activeSenderLock?.release();
    } catch (error) {
      console.error(`failed to release sender-wide run lock: ${String(error)}`);
      process.exitCode = 1;
    }
  });
