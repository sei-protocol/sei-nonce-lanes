import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, parseEther, parseUnits, type Address } from 'viem';
import { readDecimal, readInteger, type EnvSource } from './config.js';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

export const DRAGONSWAP_ROUTER: Address = getAddress(
  '0x527b42CA5e11370259EcaE68561C14dA415477C8',
);
export const DRAGONSWAP_FACTORY: Address = getAddress(
  '0xeE6Ad607238f8d2C63767245d78520F06c303D31',
);
export const WSEI: Address = getAddress('0xF8EB55EC97B59d91fe9E91A1d61147e0d2A7b6F7');
export const NATIVE_USDC: Address = getAddress(
  '0x4fCF1784B31630811181f670Aea7A7bEF803eaED',
);
export const USDC_DECIMALS = 6;

export function readSwapConfig(env: EnvSource) {
  const seiAmount = parsePositiveEther(env, 'SWAP_SEI_AMOUNT', '0.0001');
  const usdcAmount = parsePositiveUnits(env, 'SWAP_USDC_AMOUNT', '0.0001', USDC_DECIMALS);
  const liquiditySei = parsePositiveEther(env, 'SWAP_LIQUIDITY_SEI', '100');
  const liquidityUsdc = parsePositiveUnits(
    env,
    'SWAP_LIQUIDITY_USDC',
    '100',
    USDC_DECIMALS,
  );
  const retainedUsdcAllowance = parsePositiveUnits(
    env,
    'SWAP_RETAINED_USDC_ALLOWANCE',
    '10',
    USDC_DECIMALS,
  );

  return {
    seiAmount,
    usdcAmount,
    liquiditySei,
    liquidityUsdc,
    retainedUsdcAllowance,
    slippageBps: readInteger(env, 'SWAP_SLIPPAGE_BPS', 500, { min: 0, max: 5_000 }),
    deadlineSeconds: readInteger(env, 'SWAP_DEADLINE_SECONDS', 7_200, {
      min: 300,
      max: 86_400,
    }),
  } as const;
}

export const swapConfig = readSwapConfig(process.env);
export const swapOperationJournalPath =
  process.env.SWAP_OPERATION_JOURNAL_PATH?.trim() ||
  resolve(dirname(fileURLToPath(import.meta.url)), '../.state/pending-swaps.json');

function parsePositiveEther(env: EnvSource, name: string, fallback: string): bigint {
  return requirePositive(name, parseEther(readDecimal(env, name, fallback)));
}

function parsePositiveUnits(
  env: EnvSource,
  name: string,
  fallback: string,
  decimals: number,
): bigint {
  return requirePositive(name, parseUnits(readDecimal(env, name, fallback), decimals));
}

function requirePositive(name: string, value: bigint): bigint {
  if (value <= 0n) throw new Error(`${name} must be greater than zero`);
  return value;
}
