import { formatEther, formatUnits } from 'viem';
import { entryPointAbi, venueAbi } from './abi.js';
import { currentDelegation } from './delegation.js';
import {
  ENTRY_POINT,
  chain,
  config,
  configuredChainId,
  displayRpcUrl,
  laneAccountImpl,
  publicClient,
  relayerAccounts,
  trader,
  venueAddress,
} from './env.js';
import { LanePool } from './lanes.js';

async function main() {
  const rpcChainId = await publicClient.getChainId();
  console.log(`chain            ${chain.name} (${chain.id})`);
  console.log(`rpc              ${displayRpcUrl()}`);
  console.log(
    `rpc chain id     ${rpcChainId}` +
      (rpcChainId === configuredChainId ? '' : `  MISMATCH (configured ${configuredChainId})`),
  );
  console.log(`block            ${await publicClient.getBlockNumber()}`);

  const entryPointCode = await publicClient.getCode({ address: ENTRY_POINT });
  console.log(`entryPoint v0.8  ${ENTRY_POINT}  ${entryPointCode ? 'present' : 'MISSING'}`);
  const implementationCode = laneAccountImpl
    ? await publicClient.getCode({ address: laneAccountImpl })
    : undefined;
  console.log(
    `impl (configured)${laneAccountImpl ? ` ${laneAccountImpl}  ${implementationCode ? 'present' : 'MISSING'}` : ' unset'}`,
  );

  console.log('');
  console.log(`trader           ${trader.address}`);
  console.log(`  balance        ${formatEther(await publicClient.getBalance({ address: trader.address }))} SEI`);
  console.log(`  EVM nonce      ${await publicClient.getTransactionCount({ address: trader.address })}`);
  const delegation = await currentDelegation();
  const delegationStatus =
    delegation && laneAccountImpl
      ? delegation.toLowerCase() === laneAccountImpl.toLowerCase()
        ? 'matches configured implementation'
        : 'MISMATCH'
      : '';
  console.log(`  delegated to   ${delegation ?? 'not delegated'}${delegationStatus ? `  ${delegationStatus}` : ''}`);
  if (entryPointCode) {
    console.log(
      `  ep deposit     ${formatEther(
        await publicClient.readContract({
          address: ENTRY_POINT,
          abi: entryPointAbi,
          functionName: 'balanceOf',
          args: [trader.address],
        }),
      )} SEI`,
    );
  } else {
    console.log('  ep deposit     unavailable');
  }

  console.log('\nrelayers (gas only, no inventory)');
  for (const relayer of relayerAccounts) {
    const [balance, nonce, code] = await Promise.all([
      publicClient.getBalance({ address: relayer.address }),
      publicClient.getTransactionCount({ address: relayer.address }),
      publicClient.getCode({ address: relayer.address }),
    ]);
    console.log(
      `  ${relayer.address}  ${formatEther(balance).padStart(10)} SEI  nonce ${nonce}` +
        (code ? '  HAS CODE/DELEGATION' : ''),
    );
  }

  console.log('\nlane sequences (non-zero only)');
  if (entryPointCode) {
    const lanes = Array.from({ length: config.lanePoolSize }, (_, i) => BigInt(i + 1));
    const lanePool = await LanePool.create(
      publicClient,
      ENTRY_POINT,
      trader.address,
      config.lanePoolSize,
    );
    const used = lanes
      .map((lane) => ({ lane, seq: lanePool.sequence(lane)! }))
      .filter(({ seq }) => seq > 0n);
    if (used.length === 0) console.log('  none used yet');
    for (const { lane, seq } of used) {
      console.log(`  lane ${String(lane).padStart(3)}  next seq ${seq}`);
    }
  } else {
    console.log('  unavailable: EntryPoint missing');
  }

  if (venueAddress) {
    const venueCode = await publicClient.getCode({ address: venueAddress });
    console.log(`\nvenue            ${venueAddress}  ${venueCode ? 'present' : 'MISSING'}`);
    if (!venueCode) return;
    const [markPx, landed] = await Promise.all([
      publicClient.readContract({ address: venueAddress, abi: venueAbi, functionName: 'markPx' }),
      publicClient.readContract({ address: venueAddress, abi: venueAbi, functionName: 'landedCount' }),
    ]);
    console.log(`  mark           ${formatUnits(markPx, 18)}`);
    console.log(`  ops landed     ${landed}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
