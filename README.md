# Nonce lanes: concurrent submission from one Sei account

This repository is a reference implementation of nonce lanes on Sei. It shows
how one funded EVM account can submit independent actions without putting every
action behind a single sequential nonce queue.

For the full tutorial—including setup, deployment, configuration, testnet
usage, benchmarks, and troubleshooting—see the
[Sei nonce lanes documentation](https://docs.sei.io/evm/nonce-lanes).

> [!IMPORTANT]
> This is an engineering demonstration, not a production trading service. It
> uses a mock venue, development keys, an in-process queue, and local journal
> files.

## How it works

- **EIP-7702** preserves the EOA's address, balances, and approvals.
- **ERC-4337 v0.8** gives that account independent two-dimensional nonce lanes.
- **Gas-only relayers** submit `EntryPoint.handleOps` transactions without
  holding the trader's inventory.
- **A write-ahead journal** supports recovery of interrupted or evicted outer
  transactions.

Operations on different lanes have no ordering relationship, so a stuck
operation does not strand operations on other lanes. This provides submission
concurrency, not parallel execution of conflicting state changes.

The expected EntryPoint is the canonical v0.8 singleton at
`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.

![How parallel nonce submission works](assets/how-it-works.svg)

## Repository

- `src/` — EIP-7702 account implementation and mock venue
- `test/` — Foundry tests for lane ordering, isolation, and failure behavior
- `script/` — deployment script
- `app/src/` — TypeScript submission, bundling, relaying, and recovery logic
- `app/bench/` — nonce-lane and sequential-nonce benchmarks
- `.env.example` — runtime configuration reference

Dependencies under `lib/` are pinned Git submodules. Clone the repository with
`--recurse-submodules`, or initialize them in an existing clone:

```bash
git submodule update --init --recursive
```

## Development checks

The project requires Foundry and Node.js 22 or newer.

```bash
cd app
npm ci
npm run check
cd ..

forge fmt --check
forge test -vv
```

## Security

Use throwaway accounts and never commit private keys, mnemonics, `.env` files,
signed transactions, or `app/.state/`. See [SECURITY.md](SECURITY.md) for
vulnerability reporting.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
