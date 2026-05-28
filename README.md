# foc-platform

Reusable platform infrastructure for building products on top of Filecoin Onchain Cloud (FOC).

This repository is starting as a specification and planning workspace for a mostly-onchain platform stack where:

- platform users request storage through a platform API, UI, or generated app,
- platform-specific smart contracts track authorization, object ownership, usage, quotas, and billing events,
- a managed wallet, smart account, or contract treasury pays FOC for storage operations,
- offchain infrastructure is minimized and used primarily for byte movement, Synapse SDK execution, relaying, and optional indexing.

## Current status

Draft specification only. See [`spec.md`](./spec.md).

## Related projects

- [`@filoz/synapse-sdk`](https://github.com/FilOzone/synapse-sdk) — core SDK for FOC storage, payments, providers, datasets, and retrieval.
- [`foc-cli`](https://github.com/FIL-Builders/foc-cli) — CLI and agent-facing operational tooling for FOC.
- [`foc-storage-mcp`](https://github.com/FIL-Builders/foc-storage-mcp) — MCP tools for AI-agent FOC storage workflows.
- Token Host Builder — candidate framework for generating onchain platform registry, usage ledger, UI, upload adapters, and sponsored transaction scaffolding.

## Initial development direction

The draft spec keeps several implementation options open, including:

- platform EOA/KMS payer,
- smart-account payer,
- contract treasury payer,
- prepaid user balances,
- credit/quota accounting,
- trusted runner finalization,
- stronger receipt/proof models,
- Token Host-generated contracts and UI.

The next recommended step is a compatibility spike against Filecoin Calibration to determine which FOC payment and signer models are currently viable.
