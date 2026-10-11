# Beyond Borders Passport

A responsive digital stamp passport for the **Beyond Borders 2026** event by AIESEC Club. Participants sign in with Google, scan an activity QR code, collect one or more SDG stamps, and download their personalized passport as a 1080 × 1920 Instagram Story PNG.

## Included

- All 17 SDG stamps with official goal colors
- Six event days based on the previous event agenda
- Google OAuth 2.0 authentication
- PostgreSQL-backed participants, QR scans, stamps, and sessions
- Camera QR scanner with a manual-code fallback
- One QR code can award several SDG stamps
- Duplicate activity and stamp protection
- Instagram Story passport export generated locally in the browser
- Responsive layout and accessible controls
- Dockerized app and PostgreSQL database

## Run with Docker

1. Copy `.env.example` to `.env`.
2. Set a strong `SESSION_SECRET` and `POSTGRES_PASSWORD`.
3. Add Google OAuth credentials and set the authorized callback URL to `https://YOUR_DOMAIN/auth/google/callback`.
4. Set `SESSION_COOKIE_SECURE=true` when the site is served through HTTPS.
5. Start the stack:

```bash
docker compose up --build
```

Open `http://localhost:8080`. The database schema and event seed data are created automatically.

## Demo mode

Keep `DEMO_MODE=true` to expose a local demo passport. Seeded QR values are:

```text
LIVING-DAY-1
LIVING-DAY-2
LIVING-DAY-3
LIVING-DAY-4
LIVING-DAY-5
LIVING-DAY-6
```

Set `DEMO_MODE=false` in production.

## Google OAuth

Create an OAuth 2.0 Web application in Google Cloud and configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`

The callback must also be listed under the Google OAuth client's authorized redirect URIs.

## Color palette

| Token | Hex | Use |
| --- | --- | --- |
| Forest | `#123D35` | Primary surfaces and actions |
| Deep Forest | `#0B2D28` | Footer and high-contrast areas |
| Leaf | `#2C8068` | Secondary accent and labels |
| Mint | `#BFE5D5` | Soft text and supportive backgrounds |
| Impact Lime | `#D8F24A` | Scan actions and celebration |
| Warm Cream | `#F4F1E8` | Page background |
| Paper | `#FFFDF8` | Cards and passport surface |
| Coral | `#FF6B55` | Warm accent and progress gradient |

The 17 stamps use the corresponding official SDG goal colors.

## VM deployment notes

- Install Docker Engine and the Docker Compose plugin.
- Point your reverse proxy to port `8080` and terminate HTTPS there.
- Set the production domain in `GOOGLE_CALLBACK_URL`.
- Set `SESSION_COOKIE_SECURE=true` behind HTTPS.
- Back up the named `postgres_data` volume.
- Use real secrets in `.env`; never commit that file.
- Keep the database port private; only the application port is published.
