import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { sei, seiTestnet } from 'viem/chains';
import {
  assertDistinctAccounts,
  assertMainnetWriteAllowed,
  assertNoPublicDevelopmentCredentials,
  readChainId,
  readDecimal,
  readFlag,
  readInteger,
  readMnemonic,
  readOptionalAddress,
  readOptionalInteger,
  readPrivateKey,
  readRenamedInteger,
  readRpcUrl,
} from './config.js';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

/** The canonical ERC-4337 v0.8 singleton, already deployed on Pacific-1 and Atlantic-2. */
export const ENTRY_POINT: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

export const configuredChainId = readChainId(process.env);
export const chain = configuredChainId === 1329 ? sei : seiTestnet;
export const rpcUrl = readRpcUrl(process.env, chain.rpcUrls.default.http[0]!);
export const allowMainnet = readFlag(process.env, 'ALLOW_MAINNET');

/**
 * Sei produces blocks in well under a second, and viem's 4s default polling
 * interval would add up to a full four seconds of dead wait to every receipt.
 * Neither `sei` nor `seiTestnet` carries a block time for viem to derive one
 * from, so set it here or `waitForTransactionReceipt` reports timeouts and
 * triggers fee-bumped replacements for bundles that already landed.
 */
export const receiptPollingIntervalMs = readInteger(
  process.env,
  'RECEIPT_POLLING_INTERVAL_MS',
  250,
  { min: 10, max: 60_000 },
);

export const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
  pollingInterval: receiptPollingIntervalMs,
});

/** Safe for logs: preserves the host but hides credential-bearing URL paths. */
export function displayRpcUrl(url: string = rpcUrl): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' && !parsed.search ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return '[configured RPC]';
  }
}

/** The single funded account. Holds all inventory, signs every UserOperation. */
const traderPrivateKey = readPrivateKey(process.env, 'TRADER_PRIVATE_KEY');
export const trader = createTrader(traderPrivateKey);

/**
 * Gas-only submitters. Each one burns its own sequential EVM nonce, so the
 * sequential-nonce constraint lives here instead of on the trading account.
 * Compromising one can steal that relayer's gas balance or submit operations the
 * trader already signed, but cannot create new trader-authorized operations.
 */
export const relayerCount = readInteger(process.env, 'RELAYER_COUNT', 4, { min: 1, max: 256 });
/** Offset the derivation path when the relayer mnemonic is shared with another account. */
export const relayerStartIndex = readInteger(process.env, 'RELAYER_START_INDEX', 0, {
  min: 0,
  max: 2_147_483_647,
});
const relayerMnemonic = readMnemonic(process.env, 'RELAYER_MNEMONIC');
if (relayerStartIndex + relayerCount > 2_147_483_648) {
  throw new Error('RELAYER_START_INDEX + RELAYER_COUNT exceeds the supported derivation range');
}
export const relayerAccounts = createRelayers(relayerMnemonic);
assertDistinctAccounts(
  trader.address,
  relayerAccounts.map((account) => account.address),
);

export const laneAccountImpl = readOptionalAddress(process.env, 'LANE_ACCOUNT_IMPL');
export const venueAddress = readOptionalAddress(process.env, 'VENUE');
export const operationJournalPath =
  process.env.OPERATION_JOURNAL_PATH?.trim() ||
  resolve(dirname(fileURLToPath(import.meta.url)), '../.state/pending-ops.json');
export const senderRunLockPath =
  process.env.SENDER_RUN_LOCK_PATH?.trim() ||
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    `../.state/sender-${configuredChainId}-${trader.address.toLowerCase()}.lock`,
  );

const orders = readInteger(process.env, 'ORDERS', 24, { min: 1, max: 100_000 });
const lanePoolSize = readInteger(process.env, 'LANE_POOL_SIZE', 32, { min: 1, max: 4_096 });
if (orders > lanePoolSize) {
  throw new Error(`ORDERS (${orders}) cannot exceed LANE_POOL_SIZE (${lanePoolSize})`);
}

const revertOrderIndex = readRenamedInteger(
  process.env,
  'REVERT_ORDER_INDEX',
  'SABOTAGE_INDEX',
  orders > 2 ? 2 : -1,
  { min: -1, max: orders - 1 },
);
if (revertOrderIndex.usedDeprecatedName) {
  console.warn('SABOTAGE_INDEX is deprecated; rename it to REVERT_ORDER_INDEX.');
}

export const config = {
  /** How many orders to fire in one run. */
  orders,
  /**
   * Size of the lane pool, which is also the cap on in-flight operations. One
   * lane may hold at most one in-flight op, because ops sharing a lane are
   * ordered relative to each other.
   */
  lanePoolSize,
  /**
   * Operations per `handleOps` call. Larger bundles amortize the base transaction
   * cost, but a bundle is a shared failure domain for *validation* errors, so
   * widening it trades isolation for gas. Set to 1 for maximum isolation.
   */
  maxOpsPerBundle: readInteger(process.env, 'MAX_OPS_PER_BUNDLE', Math.min(4, lanePoolSize), {
    min: 1,
    max: lanePoolSize,
  }),
  /** Index of the order deliberately given an unfillable limit price, or -1 to disable. */
  revertOrderIndex: revertOrderIndex.value,

  verificationGasLimit: BigInt(
    readInteger(process.env, 'VERIFICATION_GAS_LIMIT', 150_000, { min: 1 }),
  ),
  /**
   * Floor for each operation's declared call gas, or unset to use the measured
   * estimate. The EntryPoint reserves the declared limit before running an
   * operation, so an inflated value consumes block gas limit, and therefore
   * operations per block, without changing the gas actually used.
   */
  callGasLimit: readOptionalCallGasLimit(),
  preVerificationGas: BigInt(
    readInteger(process.env, 'PRE_VERIFICATION_GAS', 60_000, { min: 1 }),
  ),
  bundleReceiptTimeoutMs: readInteger(process.env, 'BUNDLE_RECEIPT_TIMEOUT_MS', 12_000, {
    min: 1,
  }),
  bundleMaxAttempts: readInteger(process.env, 'BUNDLE_MAX_ATTEMPTS', 3, { min: 1 }),
  replacementFeeBumpPercent: readInteger(
    process.env,
    'REPLACEMENT_FEE_BUMP_PERCENT',
    25,
    { min: 10, max: 1_000 },
  ),
} as const;

function readOptionalCallGasLimit(): bigint | undefined {
  const value = readOptionalInteger(process.env, 'CALL_GAS_LIMIT', { min: 1 });
  return value === undefined ? undefined : BigInt(value);
}

export const relayerFunding = parseSeiAmount('RELAYER_FUNDING', '0.5');
export const entryPointDeposit = parseSeiAmount('ENTRYPOINT_DEPOSIT', '1');

/** Refuse to sign or send when the configured chain and RPC disagree. */
export async function assertRpcChainMatches(): Promise<void> {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== configuredChainId) {
    throw new Error(
      `RPC chain ID ${actualChainId} does not match SEI_CHAIN_ID=${configuredChainId}. ` +
        'Refusing to sign for the wrong EIP-712 domain.',
    );
  }
}

/** Guard every CLI that signs or broadcasts a transaction. */
export async function assertWriteNetwork(action: string): Promise<void> {
  await assertRpcChainMatches();
  assertNoPublicDevelopmentCredentials(rpcUrl, trader.address, relayerMnemonic);
  assertMainnetWriteAllowed(configuredChainId, rpcUrl, allowMainnet, action);
}

/** Relayers are expected to be plain gas-only EOAs, not delegated accounts or contracts. */
export async function assertPlainRelayers(action: string): Promise<void> {
  for (const relayer of relayerAccounts) {
    const code = await publicClient.getCode({ address: relayer.address });
    if (code) {
      throw new Error(
        `${action} refuses relayer ${relayer.address} because the address already has code or an EIP-7702 delegation`,
      );
    }
  }
}

export function explorerTx(hash: Hex): string {
  const base = chain.id === 1329 ? 'https://seiscan.io' : 'https://testnet.seiscan.io';
  return `${base}/tx/${hash}`;
}

function createTrader(privateKey: Hex) {
  try {
    return privateKeyToAccount(privateKey);
  } catch {
    throw new Error('TRADER_PRIVATE_KEY is not a valid secp256k1 private key');
  }
}

function createRelayers(mnemonic: string) {
  try {
    return Array.from({ length: relayerCount }, (_, i) =>
      mnemonicToAccount(mnemonic, { addressIndex: relayerStartIndex + i }),
    );
  } catch {
    throw new Error('RELAYER_MNEMONIC is not a valid BIP-39 mnemonic');
  }
}

function parseSeiAmount(name: string, fallback: string): bigint {
  const value = readDecimal(process.env, name, fallback);
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must have at most 18 decimal places`);
  }
}
