import { createPublicClient, http } from 'viem';
import { chain, displayRpcUrl, publicClient, rpcUrl } from '../src/env.js';

/**
 * Warm request latency of the configured RPC versus the public endpoint.
 *
 * Every bundle a relayer submits costs several sequential round trips
 * (estimate, fee lookup, block number, broadcast, receipt polls), so the RPC's
 * per-request latency bounds how fast a small relayer pool can turn bundles
 * around. Sei blocks arrive every ~400 ms; an RPC that answers in 300 ms makes
 * the client, not the chain, the bottleneck until the pool is wide enough.
 */
async function main() {
  const publicUrl = chain.rpcUrls.default.http[0]!;
  const targets = [
    { label: `configured (${displayRpcUrl(rpcUrl)})`, client: publicClient },
    {
      label: `public (${displayRpcUrl(publicUrl)})`,
      client: createPublicClient({ chain, transport: http(publicUrl) }),
    },
  ];
  const rounds = Number(process.env.BENCH_LATENCY_ROUNDS ?? 15);

  for (const { label, client } of targets) {
    const samples: Record<string, number[]> = { blockNumber: [], gasPrice: [], getBlock: [] };
    for (let i = 0; i < rounds; i++) {
      samples.blockNumber!.push(await timed(() => client.getBlockNumber({ cacheTime: 0 })));
      samples.gasPrice!.push(await timed(() => client.getGasPrice()));
      samples.getBlock!.push(await timed(() => client.getBlock()));
    }
    console.log(label);
    for (const [method, times] of Object.entries(samples)) {
      // Drop the first sample: it carries the TLS handshake.
      const warm = times.slice(1).sort((a, b) => a - b);
      console.log(
        `  ${method.padEnd(12)} median ${warm[Math.floor(warm.length / 2)]!.toFixed(0).padStart(4)}ms` +
          `  p90 ${warm[Math.floor(warm.length * 0.9)]!.toFixed(0).padStart(4)}ms` +
          `  min ${warm[0]!.toFixed(0).padStart(4)}ms`,
      );
    }
  }
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
