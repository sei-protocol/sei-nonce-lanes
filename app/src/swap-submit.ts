import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  maxUint256,
  parseEventLogs,
  zeroAddress,
  type Hex,
} from 'viem';
import {
  accountAbi,
  dragonSwapFactoryAbi,
  dragonSwapRouterAbi,
  entryPointAbi,
  erc20Abi,
} from './abi.js';
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
  publicClient,
  relayerAccounts,
  rpcUrl,
  senderRunLockPath,
  trader,
} from './env.js';
import { OperationJournal, type RecoveryBundle } from './journal.js';
import { LanePool } from './lanes.js';
import { PrivateMempool, type PendingOp } from './mempool.js';
import { RelayerPool, type BundleResult } from './relayers.js';
import { SenderRunLock } from './run-lock.js';
import {
  DRAGONSWAP_FACTORY,
  DRAGONSWAP_ROUTER,
  NATIVE_USDC,
  USDC_DECIMALS,
  WSEI,
  swapConfig,
  swapOperationJournalPath,
} from './swap-config.js';
import { buildOp, signUserOp, userOpHash } from './userop.js';

type SwapDirection = 'SEI->USDC' | 'USDC->SEI';

type SwapCall = {
  data: Hex;
  value: bigint;
  label: string;
};

let activeJournal: OperationJournal | undefined;
let activeSenderLock: SenderRunLock | undefined;

async function main() {
  const startedAt = Date.now();
  const implementation = laneAccountImpl;
  if (!implementation) throw new Error('Set LANE_ACCOUNT_IMPL in .env');

  await assertWriteNetwork('swap:submit');
  await assertPlainRelayers('swap:submit');
  if (chain.id !== 1328) throw new Error('Real-swap submission is restricted to Atlantic-2');
  activeSenderLock = await SenderRunLock.acquire(senderRunLockPath);

  console.log('=== real-swap preflight ===');
  console.log(`chain          ${chain.name} (${chain.id})`);
  console.log(`rpc            ${displayRpcUrl()}`);
  await assertSwapDeployments();

  const delegation = await currentDelegation();
  if (!delegation) throw new Error('Trading account is not delegated. Run: npm run delegate');
  if (delegation.toLowerCase() !== implementation.toLowerCase()) {
    throw new Error(
      `Delegation mismatch: trader delegates to ${delegation}, but LANE_ACCOUNT_IMPL is ${implementation}`,
    );
  }

  const seiToUsdcCount = Math.ceil(config.orders / 2);
  const usdcToSeiCount = Math.floor(config.orders / 2);
  const requiredSei = BigInt(seiToUsdcCount) * swapConfig.seiAmount;
  const requiredUsdc = BigInt(usdcToSeiCount) * swapConfig.usdcAmount;
  const [traderBalanceBefore, usdcBalanceBefore, allowance, depositBefore, nonceBefore] =
    await Promise.all([
      publicClient.getBalance({ address: trader.address }),
      publicClient.readContract({
        address: NATIVE_USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [trader.address],
      }),
      publicClient.readContract({
        address: NATIVE_USDC,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [trader.address, DRAGONSWAP_ROUTER],
      }),
      publicClient.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: 'balanceOf',
        args: [trader.address],
      }),
      publicClient.getTransactionCount({ address: trader.address }),
    ]);
  if (traderBalanceBefore <= requiredSei) {
    throw new Error(
      `Need more than ${formatEther(requiredSei)} SEI for swap inputs plus UserOperation gas`,
    );
  }
  if (usdcBalanceBefore < requiredUsdc) {
    throw new Error(
      `Need ${formatUnits(requiredUsdc, USDC_DECIMALS)} USDC for order-independent execution; ` +
        `trader has ${formatUnits(usdcBalanceBefore, USDC_DECIMALS)}`,
    );
  }
  if (allowance < requiredUsdc) {
    throw new Error(
      `DragonSwap USDC allowance is ${formatUnits(allowance, USDC_DECIMALS)}, ` +
        `need ${formatUnits(requiredUsdc, USDC_DECIMALS)}. Run: npm run swap:setup`,
    );
  }

  console.log(`trader         ${trader.address}`);
  console.log(`delegated to   ${delegation}`);
  console.log(`router         ${DRAGONSWAP_ROUTER}`);
  console.log(`native USDC    ${NATIVE_USDC}`);
  console.log(`SEI balance    ${formatEther(traderBalanceBefore)}`);
  console.log(`USDC balance   ${formatUnits(usdcBalanceBefore, USDC_DECIMALS)}`);
  console.log(`ep deposit     ${formatEther(depositBefore)} SEI`);
  console.log(`trader nonce   ${nonceBefore}  <- must not move during swaps`);

  const journal = await OperationJournal.open(swapOperationJournalPath, {
    chainId: chain.id,
    entryPoint: ENTRY_POINT,
    sender: trader.address,
  });
  await journal.acquireLock();
  activeJournal = journal;
  console.log(`journal        ${journal.size} pending swap(s)`);
  const persistedOutcomes = await readCompletedOutcomes(journal.completedBundles());
  if (persistedOutcomes.size > 0) {
    console.log(`receipts       recovered ${persistedOutcomes.size} completed outcome(s)`);
  }

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
  }
  console.log(`relayers       ${relayerAccounts.length} funded gas-only accounts`);

  console.log('\n=== reconcile lanes and journal ===');
  const lanePool = await LanePool.create(
    publicClient,
    ENTRY_POINT,
    trader.address,
    config.lanePoolSize,
  );
  console.log(`lane pool      ${config.lanePoolSize} lanes, ${lanePool.idleCount} idle`);

  const durableRunOps = journal.runOps();
  const pendingAtStartup = journal.allOps();
  const pendingAtStartupHashes = new Set(pendingAtStartup.map((pending) => pending.hash));
  const knownConsumed = new Set<Hex>(
    durableRunOps
      .filter((pending) => !pendingAtStartupHashes.has(pending.hash))
      .map((pending) => pending.hash),
  );

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
    const reconciledOutcomes = await readCompletedOutcomes(journal.completedBundles());
    for (const [hash, success] of reconciledOutcomes) persistedOutcomes.set(hash, success);
    console.log(`reconciled     ${alreadyConsumed.length} swap(s) already consumed`);
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
        await journal.clearAttempts(result.ops);
      }
    });
    completedRecoveryResults.push(...recoveredResults.filter((result) => result.mined));
    const unresolved = recoveredResults.filter((result) => result.pending);
    if (unresolved.length > 0) {
      throw new Error(
        `${unresolved.length} interrupted bundle(s) remain ambiguous; refusing duplicate swaps`,
      );
    }
    recoveryMs = Date.now() - recoveryStart;
  }

  console.log('\n=== quote and build ===');
  const [seiRoute, usdcRoute, fees, quoteBlock] = await Promise.all([
    publicClient.readContract({
      address: DRAGONSWAP_ROUTER,
      abi: dragonSwapRouterAbi,
      functionName: 'getAmountsOut',
      args: [swapConfig.seiAmount, [WSEI, NATIVE_USDC]],
    }),
    publicClient.readContract({
      address: DRAGONSWAP_ROUTER,
      abi: dragonSwapRouterAbi,
      functionName: 'getAmountsOut',
      args: [swapConfig.usdcAmount, [NATIVE_USDC, WSEI]],
    }),
    publicClient.estimateFeesPerGas(),
    publicClient.getBlock(),
  ]);
  const seiToUsdcQuote = seiRoute[1];
  const usdcToSeiQuote = usdcRoute[1];
  if (seiToUsdcQuote === undefined || usdcToSeiQuote === undefined) {
    throw new Error('DragonSwap returned an incomplete two-token quote');
  }
  const seiToUsdcMin = applySlippage(seiToUsdcQuote, swapConfig.slippageBps);
  const usdcToSeiMin = applySlippage(usdcToSeiQuote, swapConfig.slippageBps);
  const deadline = quoteBlock.timestamp + BigInt(swapConfig.deadlineSeconds);
  console.log(
    `quote          ${formatEther(swapConfig.seiAmount)} SEI -> ` +
      `${formatUnits(seiToUsdcQuote, USDC_DECIMALS)} USDC`,
  );
  console.log(
    `quote          ${formatUnits(swapConfig.usdcAmount, USDC_DECIMALS)} USDC -> ` +
      `${formatEther(usdcToSeiQuote)} SEI`,
  );

  const probeCalls = [
    buildSwapCall('SEI->USDC', deadline, seiToUsdcMin, usdcToSeiMin, false),
    buildSwapCall('USDC->SEI', deadline, seiToUsdcMin, usdcToSeiMin, false),
  ];
  const gasEstimates = await Promise.all(
    probeCalls.map((call) =>
      publicClient.estimateGas({
        account: ENTRY_POINT,
        to: trader.address,
        data: encodeFunctionData({
          abi: accountAbi,
          functionName: 'execute',
          args: [DRAGONSWAP_ROUTER, call.value, call.data],
        }),
      }),
    ),
  );
  const estimatedCallGas = gasEstimates.reduce((max, value) => (value > max ? value : max), 0n);
  const recommendedCallGas = (estimatedCallGas * 125n + 99n) / 100n;
  const callGasLimit =
    config.callGasLimit > recommendedCallGas ? config.callGasLimit : recommendedCallGas;
  console.log(
    `call gas       ${callGasLimit} (max estimate ${estimatedCallGas}, configured ${config.callGasLimit})`,
  );
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  const mempool = new PrivateMempool();
  const built: PendingOp[] = [...durableRunOps];
  for (const pending of journal.queuedOps()) mempool.add(pending);

  const ordersToBuild = Math.min(Math.max(config.orders - built.length, 0), lanePool.idleCount);
  const unresolvedSwapCount = mempool.size + ordersToBuild;
  const maxPrefundPerSwap =
    (config.verificationGasLimit + callGasLimit + config.preVerificationGas) * maxFeePerGas;
  const maxRunPrefund = BigInt(unresolvedSwapCount) * maxPrefundPerSwap;
  const availableNativeFunding = traderBalanceBefore + depositBefore;
  if (availableNativeFunding < requiredSei + maxRunPrefund) {
    throw new Error(
      `Insufficient native funding headroom: need up to ${formatEther(requiredSei + maxRunPrefund)} ` +
        `SEI for swap inputs and signed prefund, have ${formatEther(availableNativeFunding)}`,
    );
  }
  console.log(
    `prefund bound   <=${formatEther(maxRunPrefund)} SEI for ${unresolvedSwapCount} unresolved swap(s)`,
  );
  const runId = BigInt(Date.now());
  const signStart = Date.now();
  const pendings = await Promise.all(
    Array.from({ length: ordersToBuild }, async (_, i) => {
      const slot = lanePool.acquire();
      if (!slot) throw new Error(`lane pool exhausted at swap ${i}; raise LANE_POOL_SIZE`);

      const swapIndex = built.length + i;
      const direction: SwapDirection = swapIndex % 2 === 0 ? 'SEI->USDC' : 'USDC->SEI';
      const shouldRevert = swapIndex === config.revertOrderIndex;
      const call = buildSwapCall(
        direction,
        deadline,
        seiToUsdcMin,
        usdcToSeiMin,
        shouldRevert,
      );
      const unsigned = buildOp({
        sender: trader.address,
        lane: slot.lane,
        seq: slot.seq,
        target: DRAGONSWAP_ROUTER,
        value: call.value,
        data: call.data,
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
        orderId: runId * 100_000n + BigInt(swapIndex),
        label: call.label,
      } satisfies PendingOp;
    }),
  );
  const signMs = Date.now() - signStart;

  await journal.add(pendings);
  for (const pending of pendings) {
    built.push(pending);
    mempool.add(pending);
  }
  console.log(`signed         ${pendings.length} new swaps in ${signMs}ms`);

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
    console.log('hash check     local digest matches EntryPoint');
  }

  console.log('\n=== submit real swaps ===');
  const queuedSwaps = mempool.size;
  console.log(
    `${queuedSwaps} queued swap(s) -> bundles of <=${config.maxOpsPerBundle} -> ` +
      `${relayerAccounts.length} relayers`,
  );
  const expectedBundles = Math.ceil(queuedSwaps / config.maxOpsPerBundle);
  let settledBundles = 0;
  const submitStart = Date.now();
  const submittedResults = await relayerPool.drain(
    mempool,
    config.maxOpsPerBundle,
    async (result) => {
      if (result.mined) {
        for (const pending of result.ops) lanePool.settle(pending.lane, true);
        await journal.complete(result.ops);
      } else if (!result.pending) {
        for (const pending of result.ops) lanePool.settle(pending.lane, false);
        await journal.clearAttempts(result.ops);
      }

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
              : (result.error ?? 'failed');
        console.log(
          `bundles settled ${settledBundles}/${expectedBundles}  ` +
            `${result.mined ? 'mined' : result.pending ? 'PENDING' : 'FAILED'}  ${where}`,
        );
      }
    },
  );
  const results = [...completedRecoveryResults, ...submittedResults];
  await journal.flush();
  const submitMs = recoveryMs + (Date.now() - submitStart);

  const byHash = new Map<Hex, boolean>(persistedOutcomes);
  for (const result of results) {
    for (const [hash, ok] of result.opSuccess) byHash.set(hash, ok);
  }
  const landedHashes = new Set<Hex>(knownConsumed);
  for (const result of results) {
    if (result.mined) for (const pending of result.ops) landedHashes.add(pending.hash);
  }
  const succeeded = built.filter((pending) => byHash.get(pending.hash) === true);
  const reverted = built.filter((pending) => byHash.get(pending.hash) === false);
  const consumedWithoutReceipt = built.filter(
    (pending) => landedHashes.has(pending.hash) && !byHash.has(pending.hash),
  );
  const unexpectedOutcomes = built.filter((pending) => {
    const expected = pending.label.includes('expected revert') ? false : true;
    return byHash.get(pending.hash) !== expected;
  });
  const pendingBundles = results.filter((result) => result.pending);
  const failedBundles = results.filter((result) => !result.mined && !result.pending);
  const blocks = new Set(
    results
      .filter((result) => result.blockNumber !== undefined)
      .map((result) => result.blockNumber!.toString()),
  );

  const [traderBalanceAfter, usdcBalanceAfter, depositAfter, nonceAfter] = await Promise.all([
    publicClient.getBalance({ address: trader.address }),
    publicClient.readContract({
      address: NATIVE_USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.getTransactionCount({ address: trader.address }),
  ]);

  console.log('\n=== real-swap summary ===');
  console.log(`swaps submitted      ${built.length}`);
  console.log(`swaps landed         ${landedHashes.size}`);
  console.log(`  executed ok        ${succeeded.length}`);
  console.log(`  reverted on chain  ${reverted.length}`);
  console.log(`  recovered outcome  ${consumedWithoutReceipt.length} unknown`);
  console.log(
    `  SEI -> USDC ok     ${succeeded.filter((pending) => pending.label.startsWith('SEI->USDC')).length}`,
  );
  console.log(
    `  USDC -> SEI ok     ${succeeded.filter((pending) => pending.label.startsWith('USDC->SEI')).length}`,
  );
  console.log(`bundles              ${results.length} across ${blocks.size} block(s)`);
  console.log(`  pending recovery   ${pendingBundles.length}`);
  console.log(`  failed safely      ${failedBundles.length}`);
  console.log(`journal pending      ${journal.size}`);
  console.log(`sign time            ${signMs}ms`);
  if (recoveryMs > 0) console.log(`recovery time        ${recoveryMs}ms`);
  console.log(`submit time          ${submitMs}ms`);
  console.log(
    `throughput           ${(landedHashes.size / Math.max(submitMs / 1000, 0.001)).toFixed(1)} landed swaps/sec`,
  );
  console.log(`SEI balance          ${formatEther(traderBalanceBefore)} -> ${formatEther(traderBalanceAfter)}`);
  console.log(
    `USDC balance         ${formatUnits(usdcBalanceBefore, USDC_DECIMALS)} -> ` +
      `${formatUnits(usdcBalanceAfter, USDC_DECIMALS)}`,
  );
  console.log(`ep deposit           ${formatEther(depositBefore)} -> ${formatEther(depositAfter)} SEI`);
  console.log(
    `trader EVM nonce     ${nonceBefore} -> ${nonceAfter}  ` +
      `${nonceBefore === nonceAfter ? 'UNCHANGED' : 'MOVED (unexpected)'}`,
  );
  console.log(`total wall time      ${Date.now() - startedAt}ms`);

  for (const pending of reverted.slice(0, 10)) {
    console.log(`reverted             lane ${pending.lane}  ${pending.label}`);
  }
  if (reverted.length > 10) console.log(`reverted             ... ${reverted.length - 10} more`);

  const firstTx = results.find((result) => result.txHash)?.txHash;
  if (firstTx) console.log(`example bundle       ${explorerTx(firstTx)}`);

  if (pendingBundles.length > 0 || failedBundles.length > 0) {
    throw new Error(`${pendingBundles.length + failedBundles.length} bundle(s) require recovery`);
  }
  if (nonceBefore !== nonceAfter) throw new Error('Trader EVM nonce moved during swap submission');
  if (unexpectedOutcomes.length > 0) {
    throw new Error(
      `${unexpectedOutcomes.length} swap outcome(s) were missing or unexpected; retaining the journal`,
    );
  }
  await journal.finishRun();
}

function buildSwapCall(
  direction: SwapDirection,
  deadline: bigint,
  seiToUsdcMin: bigint,
  usdcToSeiMin: bigint,
  shouldRevert: boolean,
): SwapCall {
  const amountOutMin = shouldRevert
    ? maxUint256
    : direction === 'SEI->USDC'
      ? seiToUsdcMin
      : usdcToSeiMin;
  const suffix = shouldRevert ? ' expected revert (impossible min-out)' : '';

  if (direction === 'SEI->USDC') {
    return {
      data: encodeFunctionData({
        abi: dragonSwapRouterAbi,
        functionName: 'swapExactSEIForTokens',
        args: [amountOutMin, [WSEI, NATIVE_USDC], trader.address, deadline],
      }),
      value: swapConfig.seiAmount,
      label: `${direction}${suffix}`,
    };
  }
  return {
    data: encodeFunctionData({
      abi: dragonSwapRouterAbi,
      functionName: 'swapExactTokensForSEI',
      args: [
        swapConfig.usdcAmount,
        amountOutMin,
        [NATIVE_USDC, WSEI],
        trader.address,
        deadline,
      ],
    }),
    value: 0n,
    label: `${direction}${suffix}`,
  };
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

async function readCompletedOutcomes(bundles: RecoveryBundle[]): Promise<Map<Hex, boolean>> {
  const outcomes = new Map<Hex, boolean>();
  const recovered = await mapPool(bundles, 4, async (bundle) => {
    for (const attempt of [...bundle.attempts].reverse()) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: attempt.txHash });
        if (receipt.status !== 'success') return [] as [Hex, boolean][];
        const hashes = new Set(bundle.ops.map((pending) => pending.hash));
        return parseEventLogs({
          abi: entryPointAbi,
          eventName: 'UserOperationEvent',
          logs: receipt.logs,
        })
          .filter((event) => hashes.has(event.args.userOpHash))
          .map((event) => [event.args.userOpHash, event.args.success] as [Hex, boolean]);
      } catch {
        // Try an earlier same-nonce attempt.
      }
    }
    return [] as [Hex, boolean][];
  });
  for (const entries of recovered) {
    for (const [hash, success] of entries) outcomes.set(hash, success);
  }
  return outcomes;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
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

async function assertSwapDeployments(): Promise<void> {
  const [entryPointCode, implementationCode, routerCode, factoryCode, wseiCode, usdcCode] =
    await Promise.all([
      publicClient.getCode({ address: ENTRY_POINT }),
      laneAccountImpl ? publicClient.getCode({ address: laneAccountImpl }) : undefined,
      publicClient.getCode({ address: DRAGONSWAP_ROUTER }),
      publicClient.getCode({ address: DRAGONSWAP_FACTORY }),
      publicClient.getCode({ address: WSEI }),
      publicClient.getCode({ address: NATIVE_USDC }),
    ]);
  if (!entryPointCode || !implementationCode) {
    throw new Error('EntryPoint or configured LaneAccount implementation has no code');
  }
  if (!routerCode || !factoryCode || !wseiCode || !usdcCode) {
    throw new Error('One or more documented Atlantic-2 DragonSwap/USDC contracts have no code');
  }

  const [routerFactory, routerWsei, pair] = await Promise.all([
    publicClient.readContract({
      address: DRAGONSWAP_ROUTER,
      abi: dragonSwapRouterAbi,
      functionName: 'factory',
    }),
    publicClient.readContract({
      address: DRAGONSWAP_ROUTER,
      abi: dragonSwapRouterAbi,
      functionName: 'WSEI',
    }),
    publicClient.readContract({
      address: DRAGONSWAP_FACTORY,
      abi: dragonSwapFactoryAbi,
      functionName: 'getPair',
      args: [WSEI, NATIVE_USDC],
    }),
  ]);
  if (routerFactory.toLowerCase() !== DRAGONSWAP_FACTORY.toLowerCase()) {
    throw new Error(`Router factory mismatch: received ${routerFactory}`);
  }
  if (routerWsei.toLowerCase() !== WSEI.toLowerCase()) {
    throw new Error(`Router WSEI mismatch: received ${routerWsei}`);
  }
  if (pair === zeroAddress) throw new Error('No WSEI/native-USDC pair. Run: npm run swap:setup');
  const pairCode = await publicClient.getCode({ address: pair });
  if (!pairCode) throw new Error(`DragonSwap pair ${pair} has no code`);
  console.log(`pair           ${pair}`);
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
      console.error(`failed to release swap journal lock: ${String(error)}`);
      process.exitCode = 1;
    }
    try {
      await activeSenderLock?.release();
    } catch (error) {
      console.error(`failed to release sender-wide run lock: ${String(error)}`);
      process.exitCode = 1;
    }
  });
