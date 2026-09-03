import { createWalletClient, formatEther, http, type Address, type Hex } from 'viem';
import {
  assertPlainRelayers,
  assertWriteNetwork,
  chain,
  displayRpcUrl,
  publicClient,
  relayerAccounts,
  rpcUrl,
} from './env.js';

const POLL_MS = 4_000;

/**
 * Waits for SEI on relayer index 0, then splits it evenly across the pool.
 * Index 0 keeps its share minus gas; the rest are paid from that wallet.
 */
async function main() {
  await assertWriteNetwork('dispense');
  await assertPlainRelayers('dispense');
  if (relayerAccounts.length === 0) throw new Error('No relayers configured');

  const bank = relayerAccounts[0]!;
  const others = relayerAccounts.slice(1);
  const wallet = createWalletClient({ account: bank, chain, transport: http(rpcUrl) });

  console.log(`chain            ${chain.name} (${chain.id})`);
  console.log(`rpc              ${displayRpcUrl()}`);
  console.log(`relayers         ${relayerAccounts.length}`);
  console.log(`fund here       ${bank.address}`);
  console.log('');
  console.log('Waiting for a non-zero balance, then splitting equally.');
  console.log('');

  let bankBal = 0n;
  while (bankBal === 0n) {
    bankBal = await publicClient.getBalance({ address: bank.address });
    if (bankBal === 0n) {
      console.log(`${iso()}  still empty`);
      await sleep(POLL_MS);
    }
  }

  console.log(`received ${formatEther(bankBal)} SEI on ${bank.address}`);

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  const gasPerTx = 21_000n;
  const sends = BigInt(others.length);
  const gasReserve = (gasPerTx * sends * maxFeePerGas * 15n) / 10n;

  if (bankBal <= gasReserve) {
    throw new Error(
      `Balance ${formatEther(bankBal)} SEI is too small to cover gas for ${others.length} transfers (need ~${formatEther(gasReserve)} SEI). Send more.`,
    );
  }

  const share = (bankBal - gasReserve) / BigInt(relayerAccounts.length);
  if (share === 0n) throw new Error('Per-wallet share rounded to zero. Send more SEI.');

  console.log(`share            ${formatEther(share)} SEI`);
  console.log(`gas reserve      ${formatEther(gasReserve)} SEI`);
  console.log('');

  let nonce = await publicClient.getTransactionCount({ address: bank.address });
  const pending: { address: Address; hash: Hex; value: bigint }[] = [];

  for (const relayer of others) {
    const existing = await publicClient.getBalance({ address: relayer.address });
    if (existing >= share) {
      console.log(`  ${relayer.address}  ${formatEther(existing)} SEI  already funded`);
      continue;
    }
    const hash = await wallet.sendTransaction({
      to: relayer.address,
      value: share,
      nonce: nonce++,
      gas: gasPerTx,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    pending.push({ address: relayer.address, hash, value: share });
    console.log(`  sent ${formatEther(share)} SEI -> ${relayer.address}  ${hash}`);
  }

  for (const { address, hash, value } of pending) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`transfer to ${address} reverted  ${hash}`);
    }
    console.log(`  mined ${address}  +${formatEther(value)} SEI  block ${receipt.blockNumber}`);
  }

  console.log('\nfinal balances');
  for (const [i, relayer] of relayerAccounts.entries()) {
    const bal = await publicClient.getBalance({ address: relayer.address });
    console.log(`  ${String(i).padStart(2)}  ${relayer.address}  ${formatEther(bal).padStart(12)} SEI`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(): string {
  return new Date().toISOString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
