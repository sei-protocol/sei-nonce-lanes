import { createWalletClient, http } from 'viem';
import { chain, publicClient, relayerAccounts, rpcUrl } from './env.js';

/**
 * Demonstrates the constraint being worked around, live on Sei, using a gas-only
 * relayer key so nothing of value is at risk.
 *
 * A single account's EVM nonces are strictly sequential. Submitting nonce n+1 while
 * n is missing is not queued for later, it is rejected outright. Sei's Autobahn
 * producer mempool admits EVM transactions in per-sender nonce order and returns a
 * `bad nonce` error on a gap, and `eth_getTransactionCount(addr, "pending")` returns
 * the same value as `"latest"`, so there is no pending-nonce view to reason about.
 */
async function main() {
  const account = relayerAccounts[0];
  if (!account) throw new Error('No relayer configured');

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) throw new Error(`${account.address} has no gas. Run: npm run fund`);

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const start = await publicClient.getTransactionCount({ address: account.address });

  console.log(`account  ${account.address}`);
  console.log(`nonce    ${start}\n`);

  console.log(`1. send nonce ${start + 1}, deliberately skipping ${start}`);
  try {
    const hash = await wallet.sendTransaction({
      to: account.address,
      value: 0n,
      nonce: start + 1,
    });
    console.log(`   accepted as ${hash}`);
    console.log('   waiting 8s to see whether it can be included with a gap below it...');
    const mined = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash }).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    console.log(
      mined
        ? '   included (this node queued it, so it is not running the strict Giga path)'
        : '   NOT included: stranded behind the missing nonce, exactly the problem',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`   rejected outright: ${message}`);
  }

  console.log(`\n2. send nonce ${start} to fill the gap`);
  const hash = await wallet.sendTransaction({ to: account.address, value: 0n, nonce: start });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   included in block ${receipt.blockNumber}`);

  const end = await publicClient.getTransactionCount({ address: account.address });
  console.log(`\nnonce ${start} -> ${end}`);
  console.log('\nOne account, one queue. Compare with `npm run spray`, where 24 operations');
  console.log('from a single account are mutually independent and one failure strands nothing.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
