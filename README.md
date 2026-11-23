# Sham Haven

The project/repository name is `sham-haven`. The existing PostgreSQL database name `propertycrest` is intentionally retained for compatibility with existing local data; do not rename or recreate it during this branding update.

A full-stack Nigerian property marketplace starter. The initial build includes a cinematic React frontend, Express API, Prisma/PostgreSQL schema, cookie-based authentication, role checks, agent verification workflow, property listings and enquiries.

> **Development starter, not a production launch.** Before public launch, configure HTTPS, production secrets, managed PostgreSQL and private object storage, email/SMS delivery, backups, monitoring, legal documents and an independent security review. The 24-hour agent review is an operational target, not automatic approval.

## Requirements
- Node.js 20+
- npm 10+
- PostgreSQL 15+

## Setup

1. Create a PostgreSQL database named `propertycrest`.
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` and a long random `JWT_SECRET` (at least 32 characters).
3. From this folder run:

```bash
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Frontend: http://localhost:5173  
API health: http://localhost:4000/api/health

The seed script creates an admin only when `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are configured. Change the password immediately and never use seed credentials in production.

## Important configuration
- `CLIENT_ORIGIN` must exactly match the deployed frontend origin.
- `JWT_SECRET` must be a high-entropy secret and must never be committed.
- `UPLOAD_DIR` must point to private storage outside the public web root. Do not expose certificate uploads through static hosting.
- For production, use HTTPS and set `COOKIE_SECURE=true`.
- The current local certificate upload uses disk storage for development. Replace it with private object storage and malware scanning before launch.

## Current capabilities
- Public property browsing and keyword/location/type/transaction filtering.
- Customer and agent account registration/login/logout.
- Agent verification application submission with a private certificate file.
- Admin verification queue and approve/reject actions.
- Approved agents can create listings directly from the agent dashboard, submit property listings for admin review, upload up to 12 photos (JPG/PNG/WEBP, 8MB each), and manage listing availability with guarded status transitions (published to paused/sold/rented; paused back to published). New listings remain hidden until an administrator approves them.
- Admin property moderation queue with approve/reject decisions and audit logs.
- Property photos are stored separately from private agent certificates and served as public listing media.
- Property enquiries are stored and visible to the listing owner.
- Role-protected API routes, input validation, rate limiting, Helmet and origin checks.

## Not yet integrated
Real payments/subscriptions, live email/SMS, Google Maps/Mapbox, production object storage, identity-provider checks, automated fraud detection, formal NDPC compliance workflows and production monitoring. UI labels do not imply a property title or ownership guarantee. The platform is a discovery/advertising marketplace and does not receive rent, deposits or purchase funds.

## Phase 4 dashboard and listing workflow update

No database schema change is required for Phase 4. The agent dashboard now refreshes the signed-in profile before opening, displays the correct empty state for approved agents, and includes Add property actions. Agent listing status transitions are validated by the API and recorded in audit logs.

## Phase 3 database update

If you are upgrading an existing Phase 2 database, pull this project version and run `npm run db:generate` followed by `npm run db:migrate`. Prisma will create a migration for the new `PENDING_REVIEW` listing status. Existing listings are not automatically moved into the moderation queue.


## Phase 5 — customer saved properties
- Customer accounts can save and unsave published listings from property cards and the property detail view.
- Saved properties are stored per account in PostgreSQL and appear in the customer dashboard.
- API routes are customer-role protected; only published properties can be saved.
- Database upgrade: run `npm run db:generate` and `npm run db:migrate` from the project root. Name the migration `customer_favorites`.

## Phase 6 — Advanced property discovery

This phase adds:
- Price range filtering (minimum and maximum in NGN)
- Minimum bedroom and bathroom filters
- Sorting by newest, oldest, lowest price and highest price
- Expanded public property retrieval up to 40 results per request
- Server-side validation and filtering for search, property type, transaction type, price, bedrooms and bathrooms

### Update
Extract this project over your existing Sham Haven project after making a backup. Keep `server/.env`, PostgreSQL data and existing uploaded media. Then run:

```powershell
npm install
npm run db:generate
npm run dev
```

No Prisma schema change is introduced in Phase 6, so no database migration is required for this phase.

### Notes
The public API continues to return published listings only. Search results are capped at 40 per request; pagination can be added in a later phase. Prices are stored and compared as integer Naira values (BigInt in PostgreSQL).


## Consolidated development release
This release builds on Phase 6 and adds the following development features:
- Agent subscription plans (Starter, Growth and Premium) with server-side listing caps: 1 free listing, then 5 / 25 / 100 active listings for paid plans.
- Paystack hosted checkout initialization and server-side transaction verification. Configure `PAYSTACK_SECRET_KEY` and `PAYSTACK_CALLBACK_URL` in `server/.env` to enable checkout. Use Paystack test credentials first. Never place the secret key in frontend code.
- Agent plan selection in the dashboard and payment-return verification.
- Admin marketplace metrics for users, agents, moderation queues, published listings, enquiries and saved properties.
- Private agent certificate paths and original filenames are no longer included in user-facing profile responses.
- Enquiries are restricted to customer accounts.
- Uploaded documents and property images receive basic file-signature checks in addition to MIME-type and size checks.
- Agents can only add photos while a property is still a draft or awaiting review. Published listing media cannot be silently changed after approval.
- Demo/sample properties have been removed from the live marketplace state so sample inventory cannot be mistaken for real listings.

### Database upgrade for this release
Back up your database first. This release adds subscription and payment tables. From the project root run:

```powershell
npm install
npm run db:generate
npm run db:migrate
```

Keep your existing `server/.env`, PostgreSQL database and uploaded media. Do not delete or recreate the database. Prisma will add the new tables and enums through a migration.

### Payment configuration
Add these values to `server/.env` when ready to test subscriptions:

```env
PAYSTACK_SECRET_KEY=sk_test_your_test_secret
PAYSTACK_CALLBACK_URL=http://localhost:5173/?billing=return
```

The payment flow is disabled until a secret key is configured. Confirm the plan prices and commercial terms before going live. This billing flow is only for platform subscriptions; it does not accept rent, purchase deposits or property-sale funds.

### Still required before public launch
This is a development release, not a certified production deployment. The following still require external configuration or professional review: production hosting and HTTPS, managed private object storage, malware scanning, email/SMS delivery, map provider and geocoding keys, payment-provider live-mode approval, automated test coverage, backup/restore drills, monitoring, NDPA/FCCPC legal review, company and tax setup, and an independent penetration test. No title verification or ownership guarantee is implied by agent verification or listing moderation.


## Post-sale relisting and public listing refresh update
- Agents can request relisting for a SOLD or RENTED property when a deal is cancelled. The request moves the listing to PENDING_REVIEW; it does not publish automatically.
- The property returns to public search only after an administrator approves the relisting request.
- The agent dashboard displays a Request relisting action for SOLD and RENTED listings.
- The public marketplace fetches fresh property data when returning from the dashboard and disables browser caching for API requests, so newly approved listings can appear without requiring a full browser restart.
- The public properties endpoint already filters to PUBLISHED listings, and admin approval sets a pending listing to PUBLISHED. This update preserves that moderation rule.

No Prisma schema change is required for this workflow. Existing SOLD/RENTED listings remain in their current state until an agent requests relisting.


### Property image troubleshooting
- The API serves public listing images from `/media/properties`. The server now sends a cross-origin resource policy that allows the separate frontend to display these public images.
- The property cards use `coverImageUrl`, falling back to the first item in `images` when no cover URL is set.
- In `server/.env`, set `API_PUBLIC_ORIGIN` to the browser-reachable API base URL (for local desktop development, `http://localhost:4000`; for a phone or another device, use the computer's LAN IP and port, e.g. `http://192.168.1.20:4000`). Do not use `localhost` when the browser is running on a different device. Restart the server after changing the value.
- Existing database image URLs that point to an old or unreachable host must be updated or re-uploaded; changing this setting does not rewrite old URLs.


## Expanded admin and messaging release

This release adds an administrator control centre, agent directory, marketplace verification revocation, agent account suspension/reactivation, full property inventory, soft removal/restoration, buyer/seller conversations, user reports, reported-chat review, audit history, and Super Admin/Admin/Support Admin levels.

### Apply the additive database update safely

Back up the PostgreSQL database first. Keep the existing `server/.env`, `DATABASE_URL`, private certificate uploads, and property image uploads. From the project root run:

```powershell
npm install
npm run db:generate
npm run db:push
npm run db:seed
```

`db:push` updates the existing schema in place; do not use `prisma migrate reset`, drop the database, or delete uploads. Review the Prisma schema diff before accepting any unexpected destructive change. The seed command promotes the configured `SEED_ADMIN_EMAIL` account to Super Admin; use a unique strong `SEED_ADMIN_PASSWORD` (at least 14 characters).

### Start the project

```powershell
npm run dev
```

The Vite development server proxies `/api` and `/media` to the API on port 4000. For phone testing over the same Wi-Fi, set `CLIENT_ORIGIN` to include both the local PC frontend origin and the PC LAN frontend origin (comma-separated), and set `API_PUBLIC_ORIGIN` to the PC LAN API origin, for example `http://192.168.1.20:4000`. Replace the example IP with the PC's actual LAN IP. Do not set these to `localhost` when the phone is the browser.

### Messaging, reports and privacy

Buyer and seller conversations are stored in PostgreSQL. The API does not expose message editing or deletion. Only the buyer and seller can read their own conversations. Administrators can inspect a conversation only when it has been reported; the administrator must provide a reason and the access is recorded in the audit log. Reports preserve the conversation reference and message records. Message retention, user-facing privacy notice, access controls, backup encryption, and a documented disclosure process must be reviewed against the Nigeria Data Protection Act before public launch. Do not promise that platform logs alone guarantee a legal outcome.

### What agent revocation means

The platform can revoke Sham Haven marketplace verification and suspend access to the platform. It cannot revoke a statutory professional licence issued by ESVARBON or another regulator. A regulator's licence status must be independently checked with the issuing body. Revoking marketplace verification automatically pauses that agent's currently published listings; restoration does not automatically republish them.

### Current chat behavior

Messages refresh through short-interval polling. This is not WebSocket push delivery yet. Chat is text-only in this release; attachments and end-to-end encryption are not implemented.
