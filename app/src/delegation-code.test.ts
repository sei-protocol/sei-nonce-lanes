import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress, type Hex } from 'viem';
import { DELEGATION_PREFIX, parseDelegationDesignator } from './delegation-code.js';

const IMPLEMENTATION = '0x1234567890abcdef1234567890abcdef12345678';

test('parses an exact EIP-7702 delegation designator', () => {
  const code = `${DELEGATION_PREFIX}${IMPLEMENTATION.slice(2)}` as Hex;
  assert.equal(parseDelegationDesignator(code), getAddress(IMPLEMENTATION));
});

test('rejects empty, short, long, or unrelated code', () => {
  const exact = `${DELEGATION_PREFIX}${IMPLEMENTATION.slice(2)}`;

  assert.equal(parseDelegationDesignator(undefined), undefined);
  assert.equal(parseDelegationDesignator('0x'), undefined);
  assert.equal(parseDelegationDesignator(DELEGATION_PREFIX as Hex), undefined);
  assert.equal(parseDelegationDesignator(`${exact}00` as Hex), undefined);
  assert.equal(parseDelegationDesignator(`0x6000${'00'.repeat(21)}` as Hex), undefined);
});
