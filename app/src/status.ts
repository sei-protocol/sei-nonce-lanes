import { formatEther, formatUnits } from 'viem';
import { entryPointAbi, venueAbi } from './abi.js';
import { currentDelegation } from './delegation.js';
import {
  ENTRY_POINT,
  chain,
  config,
  displayRpcUrl,
  laneAccountImpl,
  publicClient,
  relayerAccounts,
  trader,
  venueAddress,
} from './env.js';
import { decodeLaneNonce } from './userop.js';

async function main() {
  console.log(`chain            ${chain.name} (${chain.id})`);
  console.log(`rpc              ${displayRpcUrl()}`);
  console.log(`block            ${await publicClient.getBlockNumber()}`);

  const entryPointCode = await publicClient.getCode({ address: ENTRY_POINT });
  console.log(`entryPoint v0.8  ${ENTRY_POINT}  ${entryPointCode ? 'present' : 'MISSING'}`);
  console.log(`impl (configured)${laneAccountImpl ? ` ${laneAccountImpl}` : ' unset'}`);

  console.log('');
  console.log(`trader           ${trader.address}`);
  console.log(`  balance        ${formatEther(await publicClient.getBalance({ address: trader.address }))} SEI`);
  console.log(`  EVM nonce      ${await publicClient.getTransactionCount({ address: trader.address })}`);
  console.log(`  delegated to   ${(await currentDelegation()) ?? 'not delegated'}`);
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

  console.log('\nrelayers (gas only, no inventory)');
  for (const relayer of relayerAccounts) {
    const [balance, nonce] = await Promise.all([
      publicClient.getBalance({ address: relayer.address }),
      publicClient.getTransactionCount({ address: relayer.address }),
    ]);
    console.log(`  ${relayer.address}  ${formatEther(balance).padStart(10)} SEI  nonce ${nonce}`);
  }

  console.log('\nlane sequences (non-zero only)');
  const lanes = Array.from({ length: config.lanePoolSize }, (_, i) => BigInt(i + 1));
  const nonces = await Promise.all(
    lanes.map((lane) =>
      publicClient.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: 'getNonce',
        args: [trader.address, lane],
      }),
    ),
  );
  const used = lanes
    .map((lane, i) => ({ lane, seq: decodeLaneNonce(nonces[i]!).seq }))
    .filter(({ seq }) => seq > 0n);
  if (used.length === 0) console.log('  none used yet');
  for (const { lane, seq } of used) console.log(`  lane ${String(lane).padStart(3)}  next seq ${seq}`);

  if (venueAddress) {
    const [markPx, landed] = await Promise.all([
      publicClient.readContract({ address: venueAddress, abi: venueAbi, functionName: 'markPx' }),
      publicClient.readContract({ address: venueAddress, abi: venueAbi, functionName: 'landedCount' }),
    ]);
    console.log(`\nvenue            ${venueAddress}`);
    console.log(`  mark           ${formatUnits(markPx, 18)}`);
    console.log(`  ops landed     ${landed}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
