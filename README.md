# subject_phy_portal

## Deploying the backend on Render

Set the service Root Directory to `backend`.

- Build Command: `NODE_ENV=development bun install --frozen-lockfile && bun run build`
- Start Command: `bun run start`

Configure `DATABASE_URL` and `APP_ORIGIN` in the Render environment. The build command installs development dependencies for TypeScript, while the service can still run with `NODE_ENV=production`.
