# Higgsfield CLI v1.1.24 authentication lifetime

Date checked: 2026-09-12

## Answer

Higgsfield CLI v1.1.24 does **not** require a browser login every time its access token expires. It stores an OAuth access token, refresh token, and access-token expiry, then has an automatic refresh path. Access-token expiry by itself should therefore be transparent while the persisted refresh grant remains valid.

| Layer | Lifetime | What expiry means |
| --- | --- | --- |
| OAuth access token | Set by the token endpoint's `expires_in`, not hard-coded by the CLI. Clerk's current OAuth documentation specifies **1 day (86,400 seconds)**. | The CLI can obtain another access token with its stored refresh token; browser login is not inherently required. |
| Persisted refresh grant | Long-lived. Clerk's versioned Frontend API specification says **10 years**, while another current Clerk OAuth guide says refresh tokens **never expire**. | Treat 10 years as the documented finite bound, but do not promise an unlimited lifetime. Revocation or an invalidated grant can end it earlier. |
| Clerk browser session token | **60 seconds**, normally refreshed every 50 seconds. | Not the CLI OAuth access token and not the CLI login lifetime. |
| Clerk browser session policy | Configurable; new Clerk instances default to a **7-day maximum session lifetime**. | Also not evidence that an already-authorized CLI OAuth refresh grant expires after seven days. |

The best operational answer is therefore: **expect roughly one-day access tokens, but a persisted CLI login lasting until its refresh grant is rejected, revoked, deleted, or reaches the provider's refresh-token limit—not one day and not the browser session's 60 seconds or seven days.** Because the two current Clerk sources conflict, the exact maximum refresh lifetime cannot be stated more strongly than “up to 10 years according to the current versioned API specification.”

## What v1.1.24 actually does

The official macOS arm64 v1.1.24 archive was downloaded from Higgsfield's release and verified against its published checksum (`cf23707…fe4b`). The binary identifies itself as v1.1.24, commit `74e091aaff646537b8f77d42e695ecccafbaa761`, built 2026-08-29.

Its own help describes browser-based OAuth 2.0 PKCE and a local credentials file. Static metadata in the official binary exposes:

- token-response fields `access_token`, `refresh_token`, and `expires_in`;
- persisted credential fields `access_token`, `refresh_token`, and `expires_at`;
- the refresh path `needsRefresh`, `Refresh`, and `postOAuthRefresh`.

This establishes that the server supplies the access-token lifetime and that the CLI persists enough state to refresh it. It does **not** establish a Higgsfield-specific override of Clerk's published one-day value, because no real credential or token response was inspected.

The tagged README calls tokens “short-lived” and tells users to run `higgsfield auth login` for `Session expired` or `Not authenticated`; it does not publish a numeric duration. `higgsfield auth logout --help` says it deletes the locally stored token.

## When a browser re-login is required

A fresh `higgsfield auth login` is required when the CLI has no usable refresh-capable credential set, specifically:

1. No local credentials exist, including after `higgsfield auth logout` (`Not authenticated`).
2. Stored credentials predate the refresh-capable flow (`Stored credentials use an older auth flow`).
3. The stored refresh grant is rejected—for example because it was revoked, reached the provider's lifetime, or contains a custom scope that has since been deleted (`invalid_scope`).
4. Local credentials are unreadable or invalid.

An expired access token alone is **not** a re-login trigger: the CLI's refresh path should replace it. A transient network failure reaching the token endpoint is likewise not proof that the OAuth grant is invalid; retry before discarding credentials or starting a browser login. Higgsfield's README groups failures under “Session expired,” but the public materials do not document the CLI's exact error classification, refresh skew, retry count, or refresh-token rotation behavior.

Revocation deserves one nuance: Clerk says revoking an eligible OAuth access token or refresh token revokes both tokens for the grant. It also says JWT access tokens cannot be revoked immediately, so an already-issued JWT may remain usable until its natural expiry even though future refreshes have been disabled.

## Primary sources

- [Higgsfield CLI v1.1.24 release and official binaries](https://github.com/higgsfield-ai/cli/releases/tag/v1.1.24)
- [Higgsfield CLI v1.1.24 published checksums](https://github.com/higgsfield-ai/cli/releases/download/v1.1.24/checksums.txt)
- [Higgsfield CLI v1.1.24 README: authentication and troubleshooting](https://github.com/higgsfield-ai/cli/blob/v1.1.24/README.md#troubleshooting)
- [Clerk: How Clerk implements OAuth (one-day access token; `offline_access`; guide says refresh tokens never expire)](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth)
- [Clerk Frontend API 2026-05-12 specification (one-day access token; ten-year refresh token; refresh-token grant)](https://clerk.com/docs/reference/spec/fapi/2026-05-12)
- [Clerk: Revoke an OAuth token](https://clerk.com/docs/reference/backend/oauth-applications/revoke-token)
- [Clerk: Session architecture (60-second browser session token)](https://clerk.com/docs/guides/how-clerk-works/overview)
- [Clerk: Session options (configurable inactivity and maximum lifetime)](https://clerk.com/docs/guides/secure/session-options)

## Evidence limits

No user credential file, access token, or refresh token was read or printed. The precise `expires_in` returned to a Higgsfield account and Higgsfield's Clerk instance settings were therefore not observed. Those live values would outrank Clerk's documented defaults if they differ.
