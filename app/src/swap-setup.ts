import {
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  zeroAddress,
  type Address,
} from 'viem';
import {
  dragonSwapFactoryAbi,
  dragonSwapPairAbi,
  dragonSwapRouterAbi,
  erc20Abi,
} from './abi.js';
import {
  assertWriteNetwork,
  chain,
  config,
  explorerTx,
  publicClient,
  rpcUrl,
  trader,
} from './env.js';
import {
  DRAGONSWAP_FACTORY,
  DRAGONSWAP_ROUTER,
  NATIVE_USDC,
  USDC_DECIMALS,
  WSEI,
  swapConfig,
} from './swap-config.js';

async function main() {
  await assertWriteNetwork('swap:setup');
  if (chain.id !== 1328) throw new Error('Real-swap setup is restricted to Atlantic-2');

  await assertDeployments();
  console.log('=== DragonSwap V1 / native USDC setup ===');
  console.log(`trader  ${trader.address}`);
  console.log(`router  ${DRAGONSWAP_ROUTER}`);
  console.log(`USDC    ${NATIVE_USDC}`);

  let pair = await getPair();
  let liveReserves: { wsei: bigint; usdc: bigint } | undefined;
  if (pair !== zeroAddress) {
    const reserves = await readReserves(pair);
    if (reserves.wsei > 0n && reserves.usdc > 0n) {
      liveReserves = reserves;
    }
  }
  const needsLiquidity = liveReserves === undefined;

  const [seiBalance, usdcBalance, allowance] = await Promise.all([
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
  ]);
  if (needsLiquidity && seiBalance <= swapConfig.liquiditySei) {
    throw new Error(
      `Need more than ${formatEther(swapConfig.liquiditySei)} SEI to seed liquidity and retain gas`,
    );
  }
  if (needsLiquidity && usdcBalance < swapConfig.liquidityUsdc) {
    throw new Error(
      `Need ${formatUnits(swapConfig.liquidityUsdc, USDC_DECIMALS)} native USDC; trader has ${formatUnits(usdcBalance, USDC_DECIMALS)}`,
    );
  }

  const runAllowance = BigInt(Math.floor(config.orders / 2)) * swapConfig.usdcAmount;
  const retainedAllowance =
    runAllowance > swapConfig.retainedUsdcAllowance
      ? runAllowance
      : swapConfig.retainedUsdcAllowance;
  const requiredAllowance =
    (needsLiquidity ? swapConfig.liquidityUsdc : 0n) + retainedAllowance;
  const wallet = createWalletClient({ account: trader, chain, transport: http(rpcUrl) });
  let nonce = await publicClient.getTransactionCount({ address: trader.address });

  if (allowance !== requiredAllowance) {
    if (allowance > 0n) {
      const resetHash = await wallet.writeContract({
        address: NATIVE_USDC,
        abi: erc20Abi,
        functionName: 'approve',
        args: [DRAGONSWAP_ROUTER, 0n],
        nonce: nonce++,
        chain,
      });
      await requireSuccessfulReceipt(resetHash, 'allowance reset');
      console.log(`approval reset  ${explorerTx(resetHash)}`);
    }

    const approvalHash = await wallet.writeContract({
      address: NATIVE_USDC,
      abi: erc20Abi,
      functionName: 'approve',
      args: [DRAGONSWAP_ROUTER, requiredAllowance],
      nonce: nonce++,
      chain,
    });
    await requireSuccessfulReceipt(approvalHash, 'USDC approval');
    console.log(
      `approved ${formatUnits(requiredAllowance, USDC_DECIMALS)} USDC  ${explorerTx(approvalHash)}`,
    );
  }

  if (liveReserves) {
    console.log(`pair    ${pair}`);
    console.log(
      `pool    ${formatEther(liveReserves.wsei)} WSEI / ` +
        `${formatUnits(liveReserves.usdc, USDC_DECIMALS)} USDC`,
    );
    await printQuote();
    return;
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + swapConfig.deadlineSeconds);
  const liquidityHash = await wallet.writeContract({
    address: DRAGONSWAP_ROUTER,
    abi: dragonSwapRouterAbi,
    functionName: 'addLiquiditySEI',
    args: [
      NATIVE_USDC,
      swapConfig.liquidityUsdc,
      swapConfig.liquidityUsdc,
      swapConfig.liquiditySei,
      trader.address,
      deadline,
    ],
    value: swapConfig.liquiditySei,
    nonce: nonce++,
    chain,
  });
  await requireSuccessfulReceipt(liquidityHash, 'liquidity transaction');
  console.log(
    `seeded   ${formatEther(swapConfig.liquiditySei)} SEI / ` +
      `${formatUnits(swapConfig.liquidityUsdc, USDC_DECIMALS)} USDC`,
  );
  console.log(`tx       ${explorerTx(liquidityHash)}`);

  pair = await getPair();
  if (pair === zeroAddress) throw new Error('DragonSwap factory still reports no WSEI/USDC pair');
  const reserves = await readReserves(pair);
  console.log(`pair     ${pair}`);
  console.log(
    `pool     ${formatEther(reserves.wsei)} WSEI / ${formatUnits(reserves.usdc, USDC_DECIMALS)} USDC`,
  );
  await printQuote();
}

async function assertDeployments(): Promise<void> {
  const [routerCode, factoryCode, wseiCode, usdcCode, routerFactory, routerWsei] =
    await Promise.all([
      publicClient.getCode({ address: DRAGONSWAP_ROUTER }),
      publicClient.getCode({ address: DRAGONSWAP_FACTORY }),
      publicClient.getCode({ address: WSEI }),
      publicClient.getCode({ address: NATIVE_USDC }),
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
    ]);
  if (!routerCode || !factoryCode || !wseiCode || !usdcCode) {
    throw new Error('One or more documented Atlantic-2 DragonSwap/USDC contracts have no code');
  }
  if (routerFactory.toLowerCase() !== DRAGONSWAP_FACTORY.toLowerCase()) {
    throw new Error(`Router factory mismatch: received ${routerFactory}`);
  }
  if (routerWsei.toLowerCase() !== WSEI.toLowerCase()) {
    throw new Error(`Router WSEI mismatch: received ${routerWsei}`);
  }
}

async function getPair(): Promise<Address> {
  return publicClient.readContract({
    address: DRAGONSWAP_FACTORY,
    abi: dragonSwapFactoryAbi,
    functionName: 'getPair',
    args: [WSEI, NATIVE_USDC],
  });
}

async function readReserves(pair: Address): Promise<{ wsei: bigint; usdc: bigint }> {
  const [token0, [reserve0, reserve1]] = await Promise.all([
    publicClient.readContract({
      address: pair,
      abi: dragonSwapPairAbi,
      functionName: 'token0',
    }),
    publicClient.readContract({
      address: pair,
      abi: dragonSwapPairAbi,
      functionName: 'getReserves',
    }),
  ]);
  return token0.toLowerCase() === WSEI.toLowerCase()
    ? { wsei: reserve0, usdc: reserve1 }
    : { wsei: reserve1, usdc: reserve0 };
}

async function printQuote(): Promise<void> {
  const amounts = await publicClient.readContract({
    address: DRAGONSWAP_ROUTER,
    abi: dragonSwapRouterAbi,
    functionName: 'getAmountsOut',
    args: [swapConfig.seiAmount, [WSEI, NATIVE_USDC]],
  });
  console.log(
    `quote    ${formatEther(swapConfig.seiAmount)} SEI -> ${formatUnits(amounts[1]!, USDC_DECIMALS)} USDC`,
  );
}

async function requireSuccessfulReceipt(hash: `0x${string}`, label: string): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
