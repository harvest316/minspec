---
id: DR-001
title: JWT-based Authentication Strategy
status: accepted
date: 2025-01-12
---

# DR-001: JWT-based Authentication Strategy

## Context

We need a stateless authentication mechanism for the API.

## Decision

Use JWT tokens with short expiry (15 min) and refresh tokens (7 days).

## Consequences

- Stateless: no server-side session storage needed
- Token revocation requires a blocklist (added complexity)
- Refresh token rotation mitigates theft risk
