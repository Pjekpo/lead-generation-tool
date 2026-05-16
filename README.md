# Lead Generation Tool

Web app for scraping and qualifying business leads from Google Maps via an Apify actor.

## Features

- Google Maps form inputs:
  - Search terms
  - Location
  - Number of places to extract per search term
- Backend orchestration of the configured Google Maps Apify actor
- Filters out leads with no phone number or a proper standalone website
- Lead normalization:
  - Company name
  - Phone number
  - Type/category
  - Address
  - Website
  - Needs website flag
  - Website status/reason for social, hosted, or directory URLs
  - Google Maps URL
- Deduplication
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
- `APIFY_DEFAULT_MEMORY_MBYTES` (start with `1024`)
- `WEBSITE_REDIRECT_CHECK_ENABLED` (optional, defaults to `true`)
- `WEBSITE_REDIRECT_CHECK_TIMEOUT_MS` (optional, defaults to `4000`)

The server also loads `.env.local` as a local override. Keep both `.env` and `.env.local` out of version control.

3. Start the server:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Actor Input Customization

Different Google Maps actors expect different input schemas. If your actor input does not match defaults in `server.js`, set this in `.env`:

- `APIFY_INPUT_TEMPLATE_GOOGLE_MAPS`

The template must be valid JSON and supports:

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

Default Google Maps mapping:

- `searchStringsArray`
- `locationQuery`
- `maxCrawledPlacesPerSearch`
- `language`

## Required Inputs

Google Maps needs:

- At least one search term
- One location
- Number of places to extract per search term

## Runtime Notes

- Secrets stay on the server in `.env`
- Keep `.env` out of version control
- The browser only talks to your own `/api/*` routes
- API usage is rate-limited in memory

## Deploy

This repo includes a Render blueprint in [render.yaml](render.yaml).

On Render:

1. Create a new Blueprint service from this GitHub repo
2. Set the required secret env vars:
   - `APIFY_TOKEN`
   - `APIFY_ACTOR_GOOGLE_MAPS`
3. Deploy

## Memory Tuning

If Apify shows a memory-limit warning, lower memory in `.env`:

```env
APIFY_DEFAULT_MEMORY_MBYTES=1024
APIFY_MEMORY_MBYTES_GOOGLE_MAPS=1024
```

## Compliance Note

Google Maps scraping may be restricted by platform terms, account permissions, and local privacy laws. Use approved methods, valid credentials, and compliant actors.

## Suggested Alternatives

In addition to Apify, you can combine:

- Google Places API
- Bright Data datasets/APIs
- SerpApi Google Maps extraction
- Clay + enrichment APIs
