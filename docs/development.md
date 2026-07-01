# Development

This repository uses a small Node + Foundry workspace.

## Commands

```sh
pnpm install
pnpm lint
pnpm test
pnpm test:node
pnpm test:contracts
pnpm build:contracts
```

## Environment

Copy `.env.example` to `.env` for local experiments. Do not commit real private
keys, funded wallet material, coordinator session keys, or provider credentials.

The current CI and baseline tests do not require Filecoin Calibration
credentials. Any PR that claims real FOC/Calibration execution must include
transaction hashes or logs and must keep secrets outside the repository.

## Contract Workspace

`contracts/WorkspaceSentinel.sol` is only a compile sentinel for the initial
workspace scaffold. The production `FocPlatformRegistry` contract is tracked by
issue #8 and must preserve the lifecycle, access-control, idempotency, receipt,
and accounting semantics in `spec.md` section 6.7.
