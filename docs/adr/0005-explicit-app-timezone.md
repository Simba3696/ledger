# ADR-0005: Compute "today" in an explicit application timezone

**Status:** Accepted (2026-10-05)

## Context
EMI balances, Upcoming due dates, subscription renewals and the salary reminder all depend on what calendar day "today" is. The Excel edition gets that from `new Date()` on a PC set to IST. Netlify Functions run on AWS Lambda, where the process timezone is UTC and `TZ` is a reserved variable that can't be overridden. Between 00:00 and 05:30 IST, UTC is still on the previous day. That would move due dates by a day and wrongly show or hide Upcoming items.

## Decision
Every calculation that needs "today" gets it from `todayInAppZone()` (`server/src/domain/today.ts`). That function finds the current calendar day in `APP_TIMEZONE` (IANA name, default `Asia/Kolkata`) using `Intl.DateTimeFormat`, then builds a local-midnight `Date` for that day, the convention `dateMath.ts` already uses. Calendar dates in the database are `date` columns returned as `YYYY-MM-DD` strings, never JS `Date`s.

## Alternatives considered
- **Set `TZ` on the function:** not possible on Lambda (reserved).
- **Store and compare everything in UTC:** the domain is calendar-day based (a due day of the month, "the first two weeks of the month"). Converting to UTC instants adds bugs without adding anything.

## Consequences
- Each deployment sets `APP_TIMEZONE` to the owner's zone.
- Tests pin "today" near midnight in both directions to guard against regressions.
- Domain functions keep their injectable `today` parameter, so they stay deterministic under test.
