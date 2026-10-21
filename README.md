# MilkGo Backend

Express + TypeScript API on top of Firebase (Firestore + Auth) via the Admin SDK.

## Setup
1. `npm install`
2. `cp .env.example .env` and fill it in.
3. Firebase console -> Project settings -> Service accounts -> **Generate new private key**.
   Save as `serviceAccountKey.json` in this folder (git-ignored).
4. Firebase console -> Build -> Firestore Database -> **Create database**; Authentication -> enable Email/Password (and Google).
5. `npm run dev` -> http://localhost:8080/health

## Roles (RBAC: admin > vendor > staff)
Self-signup creates a `vendor` profile with `status: pending` in Firestore `users/{uid}`;
an admin approves it (Admin panel or `npm run set-role -- you@example.com admin`).
Emails in `ADMIN_EMAILS` (.env) auto-become approved admins. Suspended/rejected users
are also disabled in Firebase Auth. All data is scoped by `vendorId` (admin sees all).
Key routes: `GET /api/v1/me`, `GET|PATCH|DELETE /api/v1/admin/users[/:id]`,
`GET|POST /api/v1/team/staff`, `PATCH /api/v1/team/staff/:id`.

## API (all under `/api/v1`, header `Authorization: Bearer <Firebase ID token>`)
`/customers`, `/products`, `/suppliers`: GET list, GET /:id, POST, PATCH /:id, DELETE /:id (owner only)

Money is stored as integer paise.
