---
id: DR-002
title: Firebase Cloud Messaging for Push Notifications
status: proposed
date: 2025-01-14
---

# DR-002: Firebase Cloud Messaging for Push Notifications

## Context

Need a cross-platform push notification solution for mobile and web.

## Decision

Use Firebase Cloud Messaging (FCM) via firebase-admin SDK.

## Consequences

- Single API for Android, iOS, and web push
- Vendor dependency on Google/Firebase
- Free tier covers our expected volume
