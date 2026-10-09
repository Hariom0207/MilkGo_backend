# MilkGo Backend

Express + TypeScript API on top of Firebase (Firestore + Auth) via the Admin SDK.

## Setup
1. `npm install`
2. `cp .env.example .env` and fill it in.
3. Firebase console -> Project settings -> Service accounts -> **Generate new private key**.
   Save as `serviceAccountKey.json` in this folder (git-ignored).
4. Firebase console -> Build -> Firestore Database -> **Create database**; Authentication -> enable Email/Password (and Google).
5. `npm run dev` -> http://localhost:8080/health

## Roles
After the first user signs up: `npm run set-role -- you@example.com owner`
(roles: `owner`, `staff`; the user must sign in again).

## API (all under `/api/v1`, header `Authorization: Bearer <Firebase ID token>`)
`/customers`, `/products`, `/suppliers`: GET list, GET /:id, POST, PATCH /:id, DELETE /:id (owner only)

Money is stored as integer paise.
