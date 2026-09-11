# Security Policy

## Scope of this repository

This repository is an engineering demonstration. It deploys a mock venue, reads
development keys from a plaintext `.env`, keeps its queue in process memory, and
reports to the console. It is not a deployed Sei asset and not a production
trading service. `README.md` lists what it deliberately leaves out under
[Security and production limitations](README.md#security-and-production-limitations).

Do not run it with keys or inventory you care about.

## Reporting a vulnerability

Do not open a public issue or pull request for a security report.

- **Bugs in this repository** — report privately through
  [GitHub Security Advisories](https://github.com/sei-protocol/sei-nonce-lanes/security/advisories/new).
  That includes anything that could mislead a reader into an unsafe action:
  a guard that does not hold, a documented invariant the code does not enforce,
  a recovery path that can double-spend a nonce, or instructions that would leak
  key material.
- **Vulnerabilities in Sei itself** — chain, node, or protocol — go to the
  [Sei Bug Bounty on Immunefi](https://immunefi.com/bug-bounty/sei/information/),
  which is the authoritative source for scope, severity, and rewards. Findings
  in this demo are not in Immunefi scope.

## Testing rules

Use a local Anvil fork or Atlantic-2 with throwaway credentials. Do not test
against `pacific-1`, public frontends, or any other shared Sei environment. The
application requires an explicit `ALLOW_MAINNET=1` opt-in before it will write to
a remote Pacific-1 RPC; treat that guard as a speed bump, not a safety boundary.

## What to include

- The commit you tested
- Chain ID and RPC path (redact credentials)
- What you expected and what happened
- A minimal reproduction, ideally a failing `forge test` or `node:test` case

## Handling key material

`.env`, `.env.*`, and `app/.state/` are gitignored and must stay that way. The
operation journal in `app/.state/` holds no private keys, but it does hold signed
UserOperations and replayable raw transactions; treat it as sensitive until the
matching nonces are consumed. Never attach any of these to a report, an issue, or
a pull request.
