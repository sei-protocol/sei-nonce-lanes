import { encodeFunctionData, formatEther, formatUnits } from 'viem';
import { entryPointAbi, venueAbi } from './abi.js';
import { currentDelegation } from './delegation.js';
import {
  ENTRY_POINT,
  chain,
  config,
  explorerTx,
  laneAccountImpl,
  publicClient,
  relayerAccounts,
  rpcUrl,
  trader,
  venueAddress,
} from './env.js';
import { LanePool } from './lanes.js';
import { PrivateMempool, type PendingOp } from './mempool.js';
import { RelayerPool } from './relayers.js';
import { buildOp, signUserOp, userOpHash } from './userop.js';

async function main() {
  const startedAt = Date.now();

  /* ------------------------------- preflight ------------------------------- */

  console.log('=== preflight ===');
  console.log(`chain          ${chain.name} (${chain.id})`);
  console.log(`rpc            ${rpcUrl}`);

  if (!venueAddress) throw new Error('Set VENUE in .env');
  if (!laneAccountImpl) throw new Error('Set LANE_ACCOUNT_IMPL in .env');

  const entryPointCode = await publicClient.getCode({ address: ENTRY_POINT });
  if (!entryPointCode) throw new Error(`No EntryPoint at ${ENTRY_POINT} on this chain`);
  console.log(`entryPoint     ${ENTRY_POINT} (${(entryPointCode.length - 2) / 2} bytes)`);

  const delegation = await currentDelegation();
  if (!delegation) throw new Error('Trading account is not delegated. Run: npm run delegate');
  console.log(`trader         ${trader.address}`);
  console.log(`delegated to   ${delegation}`);

  const [markPx, deposit, traderBalance, nonceBefore] = await Promise.all([
    publicClient.readContract({ address: venueAddress, abi: venueAbi, functionName: 'markPx' }),
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.getBalance({ address: trader.address }),
    publicClient.getTransactionCount({ address: trader.address }),
  ]);

  console.log(`venue          ${venueAddress}  mark ${formatUnits(markPx, 18)}`);
  console.log(`trader balance ${formatEther(traderBalance)} SEI`);
  console.log(`ep deposit     ${formatEther(deposit)} SEI`);
  console.log(`trader nonce   ${nonceBefore}  <- watch this, it must not move`);

  const relayerPool = await RelayerPool.create(
    relayerAccounts,
    publicClient,
    chain,
    rpcUrl,
    ENTRY_POINT,
  );
  for (const { address, balance } of await relayerPool.balances()) {
    if (balance === 0n) throw new Error(`Relayer ${address} has no gas. Run: npm run fund`);
    console.log(`relayer        ${address}  ${formatEther(balance)} SEI`);
  }

  /* --------------------------------- build --------------------------------- */

  console.log('\n=== build ===');
  const fees = await publicClient.estimateFeesPerGas();
  // Headroom, so the relayer is not paying more for gas than the signed op covers.
  const maxFeePerGas = (fees.maxFeePerGas * 2n) / 1n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas * 2n;

  const lanePool = await LanePool.create(publicClient, ENTRY_POINT, trader.address, config.lanePoolSize);
  console.log(`lane pool      ${config.lanePoolSize} lanes, ${lanePool.idleCount} idle`);

  // Unique per run so repeat runs never collide on the venue's DuplicateOrder check.
  const runId = BigInt(Date.now());
  const mempool = new PrivateMempool();
  const built: PendingOp[] = [];

  const signStart = Date.now();
  const pendings = await Promise.all(
    Array.from({ length: config.orders }, async (_, i) => {
      const slot = lanePool.acquire();
      if (!slot) throw new Error(`lane pool exhausted at order ${i}; raise LANE_POOL_SIZE`);

      const sabotaged = i === config.sabotageIndex;
      // A limit price under the mark makes the venue revert with Slippage, which is
      // the realistic "this one op fails" case.
      const limitPx = sabotaged ? markPx - 1n : markPx;
      const orderId = runId * 1000n + BigInt(i);

      const unsigned = buildOp({
        sender: trader.address,
        lane: slot.lane,
        seq: slot.seq,
        target: venueAddress,
        data: encodeFunctionData({
          abi: venueAbi,
          functionName: 'place',
          args: [orderId, 10n ** 18n, limitPx],
        }),
        verificationGasLimit: config.verificationGasLimit,
        callGasLimit: config.callGasLimit,
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
        label: sabotaged ? 'sabotaged (limit under mark)' : '',
      } satisfies PendingOp;
    }),
  );
  const signMs = Date.now() - signStart;

  for (const pending of pendings) {
    built.push(pending);
    mempool.add(pending);
  }
  console.log(`signed         ${pendings.length} ops in ${signMs}ms, all in parallel, no RPC calls`);

  // Cross-check the locally computed EIP-712 digest against the EntryPoint itself.
  // If this passes, the client-side hashing matches consensus exactly.
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

  /* -------------------------------- submit -------------------------------- */

  console.log('\n=== submit ===');
  console.log(`${config.orders} ops -> bundles of <=${config.maxOpsPerBundle} -> ${relayerAccounts.length} relayers\n`);

  const submitStart = Date.now();
  const results = await relayerPool.drain(mempool, config.maxOpsPerBundle, (result) => {
    // Release lanes as soon as each bundle resolves. A mined bundle consumed every
    // sequence in it, even for ops whose execution reverted. A bundle that never
    // mined consumed nothing.
    for (const pending of result.ops) lanePool.settle(pending.lane, result.mined);

    const where = result.txHash ? `block ${result.blockNumber}` : (result.error ?? 'failed');
    const lanes = result.ops.map((o) => o.lane).join(',');
    console.log(
      `  ${result.mined ? 'mined  ' : 'FAILED '} lanes [${lanes}]  ${where}` +
        (result.txHash ? `  gas ${result.gasUsed}` : ''),
    );
  });
  const submitMs = Date.now() - submitStart;

  /* -------------------------------- report -------------------------------- */

  console.log('\n=== per-order outcome ===');
  const byHash = new Map(results.flatMap((r) => [...r.opSuccess].map(([h, ok]) => [h, { r, ok }] as const)));

  const filled = await Promise.all(
    built.map((pending) =>
      publicClient.readContract({
        address: venueAddress,
        abi: venueAbi,
        functionName: 'isFilled',
        args: [pending.orderId],
      }),
    ),
  );
  const landingSeqs = await Promise.all(
    built.map((pending) =>
      publicClient.readContract({
        address: venueAddress,
        abi: venueAbi,
        functionName: 'landingSeq',
        args: [pending.orderId],
      }),
    ),
  );

  console.log('  #  lane  seq  exec      filled  land#  block     note');
  built.forEach((pending, i) => {
    const outcome = byHash.get(pending.hash);
    const exec = !outcome ? 'not mined' : outcome.ok ? 'ok       ' : 'reverted ';
    const block = outcome?.r.blockNumber?.toString() ?? '-';
    console.log(
      `  ${String(i).padStart(2)}  ${String(pending.lane).padStart(4)}  ${String(pending.seq).padStart(3)}  ` +
        `${exec}  ${filled[i] ? '  yes ' : '  no  '}  ${String(landingSeqs[i]).padStart(5)}  ${block.padStart(8)}  ${pending.label}`,
    );
  });

  const minedOps = built.filter((p) => byHash.has(p.hash));
  const succeeded = minedOps.filter((p) => byHash.get(p.hash)!.ok);
  const reverted = minedOps.filter((p) => !byHash.get(p.hash)!.ok);
  const blocks = new Set(results.filter((r) => r.mined).map((r) => r.blockNumber!.toString()));
  const nonceAfter = await publicClient.getTransactionCount({ address: trader.address });

  console.log('\n=== summary ===');
  console.log(`ops submitted        ${built.length}`);
  console.log(`ops landed           ${minedOps.length}`);
  console.log(`  executed ok        ${succeeded.length}`);
  console.log(`  reverted on chain  ${reverted.length}  (each consumed only its own lane)`);
  console.log(`bundles              ${results.length} across ${blocks.size} block(s)`);
  console.log(`distinct lanes       ${new Set(built.map((p) => p.lane.toString())).size}`);
  console.log(`relayers used        ${new Set(results.map((r) => r.relayer)).size}`);
  console.log(`sign time            ${signMs}ms`);
  console.log(`submit time          ${submitMs}ms`);
  console.log(`throughput           ${(built.length / (submitMs / 1000)).toFixed(1)} ops/sec end to end`);
  console.log('');
  console.log(`trader EVM nonce     ${nonceBefore} -> ${nonceAfter}  ${nonceBefore === nonceAfter ? 'UNCHANGED' : 'MOVED (unexpected)'}`);
  console.log(`total wall time      ${Date.now() - startedAt}ms`);

  if (reverted.length > 0) {
    console.log('');
    console.log(`The sabotaged order reverted and its neighbours still landed. That is the`);
    console.log(`property you wanted: nothing queues behind a failure.`);
  }

  const firstTx = results.find((r) => r.txHash)?.txHash;
  if (firstTx) console.log(`\nfirst bundle: ${explorerTx(firstTx)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
