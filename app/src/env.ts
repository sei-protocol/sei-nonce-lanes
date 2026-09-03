import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { sei, seiTestnet } from 'viem/chains';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}

/** The canonical ERC-4337 v0.8 singleton, already deployed on Pacific-1 and Atlantic-2. */
export const ENTRY_POINT: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

export const chain = num('SEI_CHAIN_ID', 1328) === 1329 ? sei : seiTestnet;
export const rpcUrl = process.env.SEI_RPC_URL ?? chain.rpcUrls.default.http[0]!;

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

/** The single funded account. Holds all inventory, signs every UserOperation. */
export const trader = privateKeyToAccount(required('TRADER_PRIVATE_KEY') as Hex);

/**
 * Gas-only submitters. Each one burns its own sequential EVM nonce, so the
 * sequential-nonce constraint lives here instead of on the trading account.
 * Compromising one of these cannot move funds; it can only pay to submit
 * UserOperations that the trader already signed.
 */
export const relayerCount = num('RELAYER_COUNT', 4);
/** Offset the derivation path when the relayer mnemonic is shared with another account. */
export const relayerStartIndex = num('RELAYER_START_INDEX', 0);
export const relayerAccounts = Array.from({ length: relayerCount }, (_, i) =>
  mnemonicToAccount(required('RELAYER_MNEMONIC'), { addressIndex: relayerStartIndex + i }),
);

export const laneAccountImpl = (process.env.LANE_ACCOUNT_IMPL ?? '') as Address;
export const venueAddress = (process.env.VENUE ?? '') as Address;

export const config = {
  /** How many orders to fire in one run. */
  orders: num('ORDERS', 24),
  /**
   * Size of the lane pool, which is also the cap on in-flight operations. One
   * lane may hold at most one in-flight op, because ops sharing a lane are
   * ordered relative to each other.
   */
  lanePoolSize: num('LANE_POOL_SIZE', 32),
  /**
   * Operations per `handleOps` call. Larger bundles amortize the base transaction
   * cost, but a bundle is a shared failure domain for *validation* errors, so
   * widening it trades isolation for gas. Set to 1 for maximum isolation.
   */
  maxOpsPerBundle: num('MAX_OPS_PER_BUNDLE', 4),
  /** Index of the order deliberately given an unfillable limit price, or -1 to disable. */
  sabotageIndex: num('SABOTAGE_INDEX', 2),

  verificationGasLimit: BigInt(num('VERIFICATION_GAS_LIMIT', 150_000)),
  callGasLimit: BigInt(num('CALL_GAS_LIMIT', 250_000)),
  preVerificationGas: BigInt(num('PRE_VERIFICATION_GAS', 60_000)),
} as const;

export function explorerTx(hash: Hex): string {
  const base = chain.id === 1329 ? 'https://seitrace.com/tx' : 'https://seitrace.com/tx';
  const suffix = chain.id === 1329 ? '?chain=pacific-1' : '?chain=atlantic-2';
  return `${base}/${hash}${suffix}`;
}
