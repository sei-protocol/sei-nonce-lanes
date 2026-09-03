import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEther, parseUnits } from 'viem';
import { readSwapConfig } from './swap-config.js';

test('reads conservative swap and liquidity defaults', () => {
  const value = readSwapConfig({});
  assert.equal(value.seiAmount, parseEther('0.0001'));
  assert.equal(value.usdcAmount, parseUnits('0.0001', 6));
  assert.equal(value.liquiditySei, parseEther('100'));
  assert.equal(value.liquidityUsdc, parseUnits('100', 6));
  assert.equal(value.retainedUsdcAllowance, parseUnits('10', 6));
  assert.equal(value.slippageBps, 500);
  assert.equal(value.deadlineSeconds, 7_200);
});

test('validates swap amounts, slippage, and deadline', () => {
  const value = readSwapConfig({
    SWAP_SEI_AMOUNT: '0.25',
    SWAP_USDC_AMOUNT: '1.5',
    SWAP_LIQUIDITY_SEI: '200',
    SWAP_LIQUIDITY_USDC: '50',
    SWAP_RETAINED_USDC_ALLOWANCE: '3',
    SWAP_SLIPPAGE_BPS: '100',
    SWAP_DEADLINE_SECONDS: '3600',
  });
  assert.equal(value.seiAmount, parseEther('0.25'));
  assert.equal(value.usdcAmount, parseUnits('1.5', 6));
  assert.equal(value.liquiditySei, parseEther('200'));
  assert.equal(value.liquidityUsdc, parseUnits('50', 6));
  assert.equal(value.retainedUsdcAllowance, parseUnits('3', 6));
  assert.equal(value.slippageBps, 100);
  assert.equal(value.deadlineSeconds, 3_600);

  assert.throws(() => readSwapConfig({ SWAP_SEI_AMOUNT: '0' }), /greater than zero/);
  assert.throws(() => readSwapConfig({ SWAP_USDC_AMOUNT: '0' }), /greater than zero/);
  assert.throws(() => readSwapConfig({ SWAP_SLIPPAGE_BPS: '5001' }), /at most 5000/);
  assert.throws(() => readSwapConfig({ SWAP_DEADLINE_SECONDS: '299' }), /at least 300/);
});
