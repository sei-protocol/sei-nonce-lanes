import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

export type EnvSource = Readonly<Record<string, string | undefined>>;

type IntegerOptions = {
  min?: number;
  max?: number;
};

const ANVIL_TRADER_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export function readRequired(env: EnvSource, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export function readInteger(
  env: EnvSource,
  name: string,
  fallback: number,
  options: IntegerOptions = {},
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a finite safe integer; received ${raw || String(value)}`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be at least ${options.min}; received ${value}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be at most ${options.max}; received ${value}`);
  }
  return value;
}

export function readChainId(env: EnvSource): 1328 | 1329 {
  const chainId = readInteger(env, 'SEI_CHAIN_ID', 1328);
  if (chainId !== 1328 && chainId !== 1329) {
    throw new Error(`SEI_CHAIN_ID must be 1328 (Atlantic-2) or 1329 (Pacific-1); received ${chainId}`);
  }
  return chainId;
}

export function readFlag(env: EnvSource, name: string, fallback = false): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`${name} must be 1, 0, true, or false; received ${env[name]}`);
}

export function readPrivateKey(env: EnvSource, name: string): Hex {
  const value = readRequired(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${name} must be a non-zero 32-byte hex private key`);
  }
  return value as Hex;
}

export function readMnemonic(env: EnvSource, name: string): string {
  const value = readRequired(env, name).replace(/\s+/g, ' ');
  const wordCount = value.split(' ').length;
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    throw new Error(`${name} must contain 12, 15, 18, 21, or 24 words; received ${wordCount}`);
  }
  if (!validateMnemonic(value, wordlist)) {
    throw new Error(`${name} must be a valid English BIP-39 mnemonic`);
  }
  return value;
}

export function readOptionalAddress(env: EnvSource, name: string): Address | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!isAddress(value)) throw new Error(`${name} must be a valid EVM address; received ${value}`);
  return getAddress(value);
}

export function readDecimal(env: EnvSource, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  const value = raw || fallback;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal amount; received ${value}`);
  }
  return value;
}

export function readRpcUrl(env: EnvSource, fallback: string): string {
  const value = env.SEI_RPC_URL?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('SEI_RPC_URL must be a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SEI_RPC_URL must use http or https; received ${parsed.protocol}`);
  }
  return value;
}

export function assertDistinctAccounts(trader: Address, relayers: readonly Address[]): void {
  const traderKey = trader.toLowerCase();
  const seen = new Set<string>();
  for (const relayer of relayers) {
    const key = relayer.toLowerCase();
    if (key === traderKey) {
      throw new Error(
        `Trader ${trader} is also configured as a relayer. Change RELAYER_START_INDEX or use a separate mnemonic.`,
      );
    }
    if (seen.has(key)) throw new Error(`Duplicate relayer address derived: ${relayer}`);
    seen.add(key);
  }
}

export function isLocalRpcUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[(.*)]$/, '$1');
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

export function assertNoPublicDevelopmentCredentials(
  rpcUrl: string,
  traderAddress: Address,
  relayerMnemonic: string,
): void {
  if (isLocalRpcUrl(rpcUrl)) return;
  if (traderAddress.toLowerCase() === ANVIL_TRADER_ADDRESS) {
    throw new Error('Refusing a remote-chain write with Anvil account 0 as TRADER_PRIVATE_KEY');
  }
  if (relayerMnemonic === ANVIL_MNEMONIC) {
    throw new Error('Refusing a remote-chain write with the public Anvil RELAYER_MNEMONIC');
  }
}

export function assertMainnetWriteAllowed(
  chainId: 1328 | 1329,
  rpcUrl: string,
  allowMainnet: boolean,
  action: string,
): void {
  if (chainId === 1329 && !isLocalRpcUrl(rpcUrl) && !allowMainnet) {
    throw new Error(
      `${action} is blocked on remote Pacific-1. Set ALLOW_MAINNET=1 only after verifying ` +
        'the account, RPC, delegation, and transaction intent.',
    );
  }
}
