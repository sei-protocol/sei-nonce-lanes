import { createWalletClient, http, getAddress } from 'viem';
import { currentDelegation } from './delegation.js';
import { chain, explorerTx, laneAccountImpl, publicClient, rpcUrl, trader } from './env.js';

async function main() {
  if (!laneAccountImpl) throw new Error('Set LANE_ACCOUNT_IMPL in .env (run the deploy script first)');

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

  // `executor: 'self'` tells viem the authorizing EOA is also sending the type-4
  // transaction, so the authorization is signed over nonce+1: the outer transaction
  // consumes the current nonce before the authorization list is processed.
  const authorization = await wallet.signAuthorization({
    contractAddress: laneAccountImpl,
    executor: 'self',
  });

  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to: trader.address,
    data: '0x',
  });
  console.log(`\nEIP-7702 authorization sent: ${explorerTx(hash)}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status ${receipt.status} in block ${receipt.blockNumber}`);

  const delegated = await currentDelegation();
  if (delegated !== getAddress(laneAccountImpl)) {
    throw new Error(`delegation did not take effect, code is now ${delegated ?? 'empty'}`);
  }

  console.log(`\nDelegated. ${trader.address} keeps its address and balance but now runs LaneAccount.`);
  console.log('This consumed the trading account\'s EVM nonce once. It should not need to again.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
