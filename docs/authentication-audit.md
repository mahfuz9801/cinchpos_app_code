# CinchPOS Authentication Audit

## Existing State

- The frontend used a local account object in browser storage.
- The login modal accepted an operator name, contact, and PIN, but the PIN was not verified by the backend.
- API routes accepted requests without identity, role, permission, business, or warehouse context.
- Customers, invoices, and payments were not tenant-scoped.
- Employee records were local records only, without secure invitation or account lifecycle handling.
- Offline POS state existed, but authentication state was not encrypted or session-aware.

## Implemented Direction

- Clerk is the primary identity provider for email/password, email verification, password reset, Google sign-in, MFA, and device sessions.
- The backend validates Clerk JWTs when `CINCHPOS_AUTH_REQUIRED=true` and Clerk issuer/JWKS values are configured.
- The backend maintains business, warehouse, role, membership, invitation, offline-session, and audit-log tables.
- API permissions are enforced by backend decorators and tenant-scoped database queries.
- The frontend uses a single API auth provider for bearer tokens and active business/warehouse headers.
- The Electron shell exposes encrypted secure storage through `safeStorage` for offline session grants.

## Tenant Model

Owner -> Business -> Warehouse -> Employee

Each authenticated request resolves:

- `user_id`
- `business_id`
- `warehouse_id`
- `role`
- `permissions`
- MFA requirement state

## Default Roles

- Owner
- Admin
- Manager
- Cashier
- Warehouse Manager
- Warehouse Staff
- Accountant
- Employee

Custom roles are stored per business and can override the default permission set.

## Offline POS Design

- CinchPOS never stores passwords locally.
- After a valid online session, the backend can issue an offline grant.
- The desktop app stores the grant and resolved auth context in encrypted OS-backed storage.
- New logins still require internet access.
- When the API returns, the frontend refreshes Clerk/backend context and replaces stale offline state.

## Required Production Configuration

Frontend:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_or_test_value
NEXT_PUBLIC_CINCHPOS_AUTH_REQUIRED=true
```

Backend:

```env
CINCHPOS_AUTH_REQUIRED=true
CLERK_ISSUER=https://your-clerk-domain.clerk.accounts.dev
CLERK_JWKS_URL=https://your-clerk-domain.clerk.accounts.dev/.well-known/jwks.json
CLERK_SECRET_KEY=sk_live_or_test_value
CLERK_AUDIENCE=
```

## Remaining Hardening Before Public Launch

- Enable Clerk email/password, email verification, password reset, Google OAuth, and MFA policies in Clerk Dashboard.
- Require MFA for owner/admin roles through Clerk organization/session policy.
- Add API rate limiting in Flask for public deployments.
- Add HTTPS and secure reverse proxy headers when hosted outside desktop localhost.
- Add a server-side employee disable/reactivate endpoint that revokes Clerk sessions through Clerk Backend API.
- Add automated end-to-end tests against a Clerk test tenant before production rollout.
