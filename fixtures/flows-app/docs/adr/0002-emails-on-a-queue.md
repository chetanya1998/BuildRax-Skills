# ADR 2: Send emails from a worker

## Status

Superseded by ADR 3

## Decision

Order confirmations go through BullMQ (`emails` queue) so that `POST /api/orders` never waits on
the mail provider.
