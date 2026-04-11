# Lead Generation Tool

Web app for scraping and qualifying business leads from Google Maps and Facebook via Apify actors.

## Features

- Web form input:
  - Company type (optional toggle on/off)
  - Service need / buyer intent text
  - Location
  - Time filter (last week, 2 months, etc.)
  - Number of leads
- Source selection
- Source-specific options:
  - Google Maps search terms + location query + max places + language
  - Facebook page/profile URLs + results limit + transcript + date filters
- Backend orchestration of Apify actors per source
- Lead normalization to a common format:
  - Company name
  - Person name / username
  - Phone number
  - Type
  - Address
- AI-style sentiment + intent scoring from post content
- Evidence snippet extraction (content that implies service need)
- Basic lead qualification scoring
- Deduplication across sources
- Results table in browser

## Stack

- Node.js + Express
- Apify Client SDK
- HTML/CSS/Vanilla JS frontend

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and set:
   - `APIFY_TOKEN`
   - `APIFY_ACTOR_GOOGLE_MAPS`
   - `APIFY_ACTOR_FACEBOOK`
   - `APP_ADMIN_PASSWORD`
   - `APIFY_DEFAULT_MEMORY_MBYTES` (start with `1024`)
   - `APIFY_SOURCE_CONCURRENCY` (set to `1` to avoid memory spikes)

3. Start the server:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Actor input customization

Different actors expect different input schemas. If your actor input does not match defaults in `server.js`, set these in `.env`:

- `APIFY_INPUT_TEMPLATE_GOOGLE_MAPS`
- `APIFY_INPUT_TEMPLATE_FACEBOOK`

Each template must be valid JSON and supports:

- `{{companyType}}`
- `{{serviceNeed}}`
- `{{location}}`
- `{{limit}}`
- `{{query}}`
- `{{searchQuery}}`
- `{{searchTopic}}`
- `{{intentQueries}}`
- `{{timeWindow}}`
- `{{timeWindowLabel}}`
- `{{sinceDateIso}}`
- `{{sinceEpochMs}}`
- `{{sinceEpochSec}}`

Example:

```env
APIFY_INPUT_TEMPLATE_GOOGLE_MAPS={"searchString":"{{searchTopic}} in {{location}}","maxCrawledPlaces":"{{limit}}"}
```

For Facebook actors that require `startUrls`, the app auto-builds search URLs from your Facebook keywords.

Default source mappings in this app:

- Google Maps: uses `searchStringsArray`, `locationQuery`, `maxCrawledPlacesPerSearch`, and `language`
- Facebook: uses `startUrls`, `resultsLimit`, `captionText`, `onlyPostsNewerThan`, and `onlyPostsOlderThan`

## Required inputs by source

- Google Maps:
  - Location or Google Maps location query
  - One of: company type, service need, or Google Maps search terms
- Facebook:
  - At least one public Facebook page/profile URL

## Access control

This app is designed to be safe for a public GitHub repo, but it should not be exposed without authentication.

- Secrets stay on the server in `.env`
- The browser only talks to your own `/api/*` routes
- Protected API routes require a login session
- Login attempts and API usage are rate-limited in memory

Minimum production setup:

- Set `APP_ADMIN_PASSWORD`
- Keep `.env` out of version control
- Deploy the Node server, not a static-only export

## Memory tuning (fix for memory-limit warnings)

If Apify shows a memory-limit warning (for example requested `4096MB`), lower memory in `.env`:

```env
APIFY_DEFAULT_MEMORY_MBYTES=1024
APIFY_MEMORY_MBYTES_GOOGLE_MAPS=1024
APIFY_SOURCE_CONCURRENCY=1
```

You can also set per-source values:

- `APIFY_MEMORY_MBYTES_GOOGLE_MAPS`
- `APIFY_MEMORY_MBYTES_FACEBOOK`

## Qualification logic

Each lead gets a score (0-100) based on data completeness:

- Name present
- Phone present
- Address present
- Type present
- Website present

Qualified leads are those with score >= `LEAD_QUALIFICATION_THRESHOLD`.

## Compliance note

Scraping social platforms may be restricted by platform terms, account permissions, and local privacy laws. Use approved methods, valid credentials, and compliant actors.

## Suggested alternatives

In addition to Apify, you can combine:

- Google Places API (stable for business listings)
- Bright Data datasets/APIs
- SerpApi (Google Maps extraction via API)
- Clay + enrichment APIs (Clearbit, Apollo, Hunter) for qualification
