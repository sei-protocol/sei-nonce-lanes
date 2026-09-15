# Standalone EntryPoint v0.8 deployer

This utility installs the canonical ERC-4337 v0.8 EntryPoint at:

```text
0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
```

It is deliberately separate from the nonce-lanes app and does not change that
app's supported networks or configuration.

## Run

Use only on a testnet with Cancun opcodes. The account needs enough native token
for roughly 5 million gas. If the canonical CREATE2 proxy is absent, it also
needs 0.01 native token to bootstrap that proxy.

```bash
cd extras/entrypoint-v08
npm ci

RPC_URL=https://your-testnet-rpc.example \
CHAIN_ID=12345 \
DEPLOYER_PRIVATE_KEY=0x... \
npm run deploy
```

`CHAIN_ID` is mandatory and is checked against the RPC before any transaction is
sent. `DEPLOYER_PRIVATE_KEY` is not needed when the EntryPoint is already there;
in that case the command only verifies it.

The deployer:

1. reads the exact v0.8 init code from the repository's pinned
   `account-abstraction` submodule;
2. verifies that the official salt and init code predict the canonical address;
3. checks Cancun `TSTORE` support before deploying;
4. verifies or bootstraps Arachnid's canonical CREATE2 proxy;
5. deploys and verifies the EntryPoint, its EIP-712 domain, and its
   `SenderCreator`.

Some chains reject the legacy unprotected transaction used to bootstrap the
canonical CREATE2 proxy. If that proxy is missing and the RPC rejects the
transaction, the testnet operator must install the proxy at
`0x4e59b44847b379578588920cA78FbF26c0B4956C` through genesis or a
chain-specific mechanism.

EntryPoint v0.8 requires Cancun, but the nonce-lanes demo also requires the
target chain to support EIP-7702. This utility cannot add EIP-7702 support to a
chain.
