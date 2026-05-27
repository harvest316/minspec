---
id: SPEC-003
title: Push Notifications
tier: T3
status: done
created: 2025-01-10
phases:
  specify: done
  clarify: done
  plan: done
  tasks: done
  implement: done
---

# Push Notifications

## Specify

Implement push notifications via FCM for mobile and web clients.

## Clarify

- [x] FCM supports both Android and iOS via same API
- [x] Web push uses VAPID keys

## Plan

Use firebase-admin SDK server-side. Store device tokens in user profile.

## Tasks

- [x] Add firebase-admin dependency
- [x] Create notification service
- [x] Add device token registration endpoint
- [x] Send notification on new message event

## Implement

Completed 2025-01-25. All notification types working.
