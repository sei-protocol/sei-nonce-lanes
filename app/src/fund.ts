import { createWalletClient, formatEther, http, parseEther } from 'viem';
import { ENTRY_POINT, chain, publicClient, relayerAccounts, rpcUrl, trader } from './env.js';
import { entryPointAbi } from './abi.js';

const PER_RELAYER = parseEther(process.env.RELAYER_FUNDING ?? '0.5');
const DEPOSIT = parseEther(process.env.ENTRYPOINT_DEPOSIT ?? '1');

/**
 * Tops up the gas-only relayers and pre-deposits the trading account's gas into the
 * EntryPoint.
 *
 * The deposit is worth doing: with a positive EntryPoint balance, `missingAccountFunds`
 * is zero, so validation skips the per-operation value transfer back to the EntryPoint.
 */
async function main() {
  const wallet = createWalletClient({ account: trader, chain, transport: http(rpcUrl) });

  const traderBalance = await publicClient.getBalance({ address: trader.address });
  console.log(`trader ${trader.address}  ${formatEther(traderBalance)} SEI`);

  let nonce = await publicClient.getTransactionCount({ address: trader.address });

  for (const relayer of relayerAccounts) {
    const balance = await publicClient.getBalance({ address: relayer.address });
    if (balance >= PER_RELAYER) {
      console.log(`  ${relayer.address}  ${formatEther(balance)} SEI  already funded`);
      continue;
    }
    const topUp = PER_RELAYER - balance;
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

  if (deposit < DEPOSIT) {
    const hash = await wallet.writeContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'depositTo',
      args: [trader.address],
      value: DEPOSIT - deposit,
      nonce: nonce++,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`topped up to ${formatEther(DEPOSIT)} SEI  ${hash}`);
  }

  console.log('\nNote: these transfers used the trading account\'s sequential EVM nonce.');
  console.log('Funding is an admin operation. The trading path below never touches it.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
