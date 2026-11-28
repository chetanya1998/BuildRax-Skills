# 1. Store orders in PostgreSQL

- Status: Accepted
- Date: 2026-03-02

## Context

Orders need transactions across order lines and payments.

## Decision

We keep orders in PostgreSQL and read them through `web/src/lib/db.ts` only, because one
connection pool per process is easier to reason about than one per route.

## Consequences

Every endpoint that touches orders depends on `db.ts`.
