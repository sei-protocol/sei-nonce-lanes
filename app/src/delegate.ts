import { createWalletClient, http, getAddress } from 'viem';
import { currentDelegation } from './delegation.js';
import {
  assertWriteNetwork,
  chain,
  explorerTx,
  laneAccountImpl,
  publicClient,
  rpcUrl,
  trader,
} from './env.js';

async function main() {
  if (!laneAccountImpl) throw new Error('Set LANE_ACCOUNT_IMPL in .env (run the deploy script first)');
  await assertWriteNetwork('delegate');

  const implementationCode = await publicClient.getCode({ address: laneAccountImpl });
  if (!implementationCode) {
    throw new Error(`LANE_ACCOUNT_IMPL ${laneAccountImpl} has no code on ${chain.name}`);
  }

  console.log(`chain      ${chain.name} (${chain.id})`);
  console.log(`trader     ${trader.address}`);
  console.log(`target     ${laneAccountImpl}`);

  const existing = await currentDelegation();
  if (existing === getAddress(laneAccountImpl)) {
    console.log('\nAlready delegated to this implementation. Nothing to do.');
    return;
  }
  if (existing) console.log(`\nCurrently delegated to ${existing}, replacing it.`);

  const wallet = createWalletClient({ account: trader, chain, transport: http(rpcUrl) });

  // Pin both nonces to one confirmed read. Left unset, viem fills each from
  // `eth_getTransactionCount(addr, "pending")`, the tag this repo treats as
  // unreliable on Sei. A wrong authorization nonce is not rejected: the tuple is
  // skipped, the transaction still succeeds, and nothing is installed.
  //
  // The trader sends the type-4 transaction itself, so the outer transaction
  // consumes `nonce` before the authorization list is processed and the
  // authorization has to be signed over `nonce + 1`.
  const nonce = await publicClient.getTransactionCount({ address: trader.address });
  console.log(`nonce      ${nonce} (authorization signed over ${nonce + 1})`);

  const authorization = await wallet.signAuthorization({
    contractAddress: laneAccountImpl,
    nonce: nonce + 1,
  });

  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to: trader.address,
    data: '0x',
    nonce,
  });
  console.log(`\nEIP-7702 authorization sent: ${explorerTx(hash)}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status ${receipt.status} in block ${receipt.blockNumber}`);

  const delegated = await currentDelegation();
  if (delegated !== getAddress(laneAccountImpl)) {
    throw new Error(`delegation did not take effect, code is now ${delegated ?? 'empty'}`);
  }

  console.log(`\nDelegated. ${trader.address} keeps its address and balance but now runs LaneAccount.`);
  // Self-sponsored: the transaction consumes one nonce, then the authorization
  // (signed over nonce+1) consumes another. Only a sponsored delegation costs one.
  console.log(
    `This advanced the trading account's EVM nonce from ${nonce} to ${nonce + 2}, once for ` +
      'the transaction and once for the authorization. It should not need to again.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
