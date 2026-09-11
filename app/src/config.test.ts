import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import {
  assertDistinctAccounts,
  assertMainnetWriteAllowed,
  assertNoPublicDevelopmentCredentials,
  isLocalRpcUrl,
  readChainId,
  readDecimal,
  readFlag,
  readInteger,
  readMnemonic,
  readOptionalAddress,
  readPrivateKey,
  readRenamedInteger,
  readRpcUrl,
} from './config.js';

const TRADER = '0x1111111111111111111111111111111111111111' as Address;
const RELAYER = '0x2222222222222222222222222222222222222222' as Address;
const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('reads supported chains and rejects ambiguous chain configuration', () => {
  assert.equal(readChainId({}), 1328);
  assert.equal(readChainId({ SEI_CHAIN_ID: '1329' }), 1329);
  assert.throws(() => readChainId({ SEI_CHAIN_ID: '31337' }), /must be 1328.*or 1329/);
  assert.throws(() => readChainId({ SEI_CHAIN_ID: 'sei' }), /finite safe integer/);
});

test('validates integer ranges instead of silently accepting NaN or zero', () => {
  assert.equal(readInteger({}, 'COUNT', 4, { min: 1 }), 4);
  assert.equal(readInteger({ COUNT: '8' }, 'COUNT', 4, { min: 1, max: 10 }), 8);
  assert.throws(() => readInteger({ COUNT: '0' }, 'COUNT', 4, { min: 1 }), /at least 1/);
  assert.throws(() => readInteger({ COUNT: '1.5' }, 'COUNT', 4), /finite safe integer/);
  assert.throws(() => readInteger({ COUNT: 'NaN' }, 'COUNT', 4), /finite safe integer/);
});

test('accepts a renamed variable under its deprecated name, preferring the new one', () => {
  const read = (env: Record<string, string>) =>
    readRenamedInteger(env, 'NEW', 'OLD', -1, { min: -1, max: 9 });

  assert.deepEqual(read({}), { value: -1, usedDeprecatedName: false });
  assert.deepEqual(read({ NEW: '3' }), { value: 3, usedDeprecatedName: false });
  assert.deepEqual(read({ OLD: '5' }), { value: 5, usedDeprecatedName: true });
  // The new name wins so a stale alias cannot silently override a deliberate value.
  assert.deepEqual(read({ NEW: '3', OLD: '5' }), { value: 3, usedDeprecatedName: false });
  // A blank alias is not a value.
  assert.deepEqual(read({ OLD: '  ' }), { value: -1, usedDeprecatedName: false });
  // Range validation still applies, and reports the name the operator actually set.
  assert.throws(() => read({ OLD: '99' }), /OLD must be at most 9/);
});

test('validates flags, keys, mnemonics, addresses, amounts, and RPC URLs', () => {
  assert.equal(readFlag({}, 'ALLOW'), false);
  assert.equal(readFlag({ ALLOW: 'true' }, 'ALLOW'), true);
  assert.equal(readFlag({ ALLOW: '0' }, 'ALLOW', true), false);
  assert.throws(() => readFlag({ ALLOW: 'yes' }, 'ALLOW'), /must be 1, 0, true, or false/);

  assert.equal(readPrivateKey({ KEY: PRIVATE_KEY }, 'KEY'), PRIVATE_KEY);
  assert.throws(() => readPrivateKey({ KEY: '0x' }, 'KEY'), /non-zero 32-byte/);
  assert.throws(() => readPrivateKey({ KEY: `0x${'00'.repeat(32)}` }, 'KEY'), /non-zero 32-byte/);

  assert.equal(readMnemonic({ MNEMONIC }, 'MNEMONIC'), MNEMONIC);
  assert.throws(() => readMnemonic({ MNEMONIC: 'too few words' }, 'MNEMONIC'), /must contain/);
  assert.throws(
    () => readMnemonic({ MNEMONIC: 'abandon '.repeat(11) + 'abandon' }, 'MNEMONIC'),
    /valid English BIP-39/,
  );

  assert.equal(readOptionalAddress({ ADDRESS: TRADER }, 'ADDRESS'), TRADER);
  assert.equal(readOptionalAddress({}, 'ADDRESS'), undefined);
  assert.throws(() => readOptionalAddress({ ADDRESS: '0x1234' }, 'ADDRESS'), /valid EVM address/);

  assert.equal(readDecimal({}, 'AMOUNT', '0.5'), '0.5');
  assert.equal(readDecimal({ AMOUNT: '10' }, 'AMOUNT', '0.5'), '10');
  assert.throws(() => readDecimal({ AMOUNT: '-1' }, 'AMOUNT', '0.5'), /non-negative decimal/);

  assert.equal(readRpcUrl({}, 'https://example.com'), 'https://example.com');
  assert.throws(() => readRpcUrl({ SEI_RPC_URL: 'ws://example.com' }, ''), /must use http or https/);
});

test('requires distinct trader and relayer identities', () => {
  assert.doesNotThrow(() => assertDistinctAccounts(TRADER, [RELAYER]));
  assert.throws(() => assertDistinctAccounts(TRADER, [TRADER]), /also configured as a relayer/);
  assert.throws(() => assertDistinctAccounts(TRADER, [RELAYER, RELAYER]), /Duplicate relayer/);
});

test('recognizes loopback RPCs and blocks public development credentials remotely', () => {
  const anvilTrader = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
  const anvilMnemonic = 'test test test test test test test test test test test junk';

  assert.equal(isLocalRpcUrl('http://localhost:8545'), true);
  assert.equal(isLocalRpcUrl('http://127.0.0.2:8545'), true);
  assert.equal(isLocalRpcUrl('http://[::1]:8545'), true);
  assert.equal(isLocalRpcUrl('https://evm-rpc-testnet.sei-apis.com'), false);

  assert.doesNotThrow(() =>
    assertNoPublicDevelopmentCredentials('http://127.0.0.1:8545', anvilTrader, anvilMnemonic),
  );
  assert.throws(
    () =>
      assertNoPublicDevelopmentCredentials(
        'https://evm-rpc-testnet.sei-apis.com',
        anvilTrader,
        MNEMONIC,
      ),
    /Anvil account 0/,
  );
  assert.throws(
    () =>
      assertNoPublicDevelopmentCredentials(
        'https://evm-rpc-testnet.sei-apis.com',
        TRADER,
        anvilMnemonic,
      ),
    /public Anvil/,
  );
});

test('requires an explicit opt-in for remote Pacific-1 writes', () => {
  assert.doesNotThrow(() =>
    assertMainnetWriteAllowed(1328, 'https://evm-rpc-testnet.sei-apis.com', false, 'submit'),
  );
  assert.doesNotThrow(() =>
    assertMainnetWriteAllowed(1329, 'http://127.0.0.1:8545', false, 'submit'),
  );
  assert.doesNotThrow(() =>
    assertMainnetWriteAllowed(1329, 'https://evm-rpc.sei-apis.com', true, 'submit'),
  );
  assert.throws(
    () => assertMainnetWriteAllowed(1329, 'https://evm-rpc.sei-apis.com', false, 'submit'),
    /submit is blocked on remote Pacific-1/,
  );
});
