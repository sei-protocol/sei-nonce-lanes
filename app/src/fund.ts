import { createWalletClient, formatEther, http } from 'viem';
import {
  ENTRY_POINT,
  assertPlainRelayers,
  assertWriteNetwork,
  chain,
  entryPointDeposit,
  publicClient,
  relayerAccounts,
  relayerFunding,
  rpcUrl,
  trader,
} from './env.js';
import { entryPointAbi } from './abi.js';

/**
 * Tops up the gas-only relayers and pre-deposits the trading account's gas into the
 * EntryPoint.
 *
 * The deposit is worth doing: with a positive EntryPoint balance, `missingAccountFunds`
 * is zero, so validation skips the per-operation value transfer back to the EntryPoint.
 */
async function main() {
  await assertWriteNetwork('fund');
  await assertPlainRelayers('fund');
  const wallet = createWalletClient({ account: trader, chain, transport: http(rpcUrl) });

  const traderBalance = await publicClient.getBalance({ address: trader.address });
  console.log(`trader ${trader.address}  ${formatEther(traderBalance)} SEI`);

  let nonce = await publicClient.getTransactionCount({ address: trader.address });

  for (const relayer of relayerAccounts) {
    const balance = await publicClient.getBalance({ address: relayer.address });
    if (balance >= relayerFunding) {
      console.log(`  ${relayer.address}  ${formatEther(balance)} SEI  already funded`);
      continue;
    }
    const topUp = relayerFunding - balance;
    const hash = await wallet.sendTransaction({
      to: relayer.address,
      value: topUp,
      nonce: nonce++,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${relayer.address}  +${formatEther(topUp)} SEI  ${hash}`);
  }

  const deposit = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: entryPointAbi,
    functionName: 'balanceOf',
    args: [trader.address],
  });
  console.log(`\nEntryPoint deposit for trader: ${formatEther(deposit)} SEI`);

  if (deposit < entryPointDeposit) {
    const hash = await wallet.writeContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'depositTo',
      args: [trader.address],
      value: entryPointDeposit - deposit,
      nonce: nonce++,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`topped up to ${formatEther(entryPointDeposit)} SEI  ${hash}`);
  }

  console.log('\nNote: these transfers used the trading account\'s sequential EVM nonce.');
  console.log('Funding is an admin operation. The trading path below never touches it.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
