# Scentinel — fragrance market monitor

Scentinel checks new `r/fragranceswap` sale posts, extracts structured listings, normalizes value by effective volume, and delivers explainable Telegram alerts. The Terminal-only authenticated JSON source reads Reddit using your locally saved login session, with at least 90 seconds between requests. It includes a compact local market dashboard when `PORT` is enabled.

## What changed

- Durable, serialized writes prevent concurrent Telegram and Reddit work from losing data.
- Reddit publication timestamps—not crawl time—drive 30-day market calculations.
- Listings retain price, size, fill, condition, decant status, listing state, source line, and normalized price per ml.
- Deal ranking uses a 30-day median and IQR outlier rejection. It requires at least five comparable active listings and labels confidence by sample size.
- Watches support price, size, fill, and decant requirements. Alerts contain only four lines: the fragrance name from the matching watch (linked to the sale), price, bottle volume, and fill percentage. New watches preserve the capitalization you enter; older watches use their saved query. Seller wording and aliases never replace that alert name. Overlapping watches deliver once, using the first matching watch's name.
- Polling is non-overlapping, network calls have a timeout, and `/health` exposes ingestion state and basic delivery metrics.
- Reddit polling has a hard 90-second minimum and uses progressively longer delays after 403 or 429 responses.

## Telegram commands

Telegram’s command menu is configured automatically at startup. The bot also puts inline actions below its messages: browse today’s deals, manage watches, create a watch, view a source listing, open market stats, or remove an individual watch without typing a command.

```text
/add aventus absolu under $180 min 90ml min 85%
/add creed aventus include decants
/list
/find aventus absolu
/stats aventus absolu
/deals
/remove aventus absolu
/stop
```

`/find` searches active listings indexed during the last 30 days using fragrance and brand words in any order. For example, `/find aventus absolu` and `/find absolu aventus` find the same fragrance; `/find creed` searches the brand. Common brand abbreviations such as PDM and MFK are supported. Results include names, source links, volumes, and decant/sample labels. This searches the local index, not Reddit history.

Watches require every word in the fragrance name you supplied, in any order, or every word in an explicitly added alias. Catalog guesses never replace those requirements. Variant names such as Superleggera and Intensivo remain in the source name used for matching; common brand abbreviations and AHS (Allure Homme Sport) are expanded. Matching ignores URLs, parenthetical seller notes, and prose after a named item's price, which can mention unrelated trade requests or clone comparisons. Filters still apply to every match. Alerts are tracked separately for each chat and only consider posts published after that watch was created. On the first startup after this fix, stored listing names are rebuilt from their source lines while preserving watches, listing IDs, sold/removed state, and delivery history. Ambiguous rows with multiple prices are retired.

`/deals` only shows bottles posted in the last 24 hours that are at least 5% below the 30-day median. Decants and samples are excluded from both deals and market comparisons. At least five comparable observations must remain after outlier rejection; the candidate’s own post is excluded from its comparison. `/stats` also uses bottle observations only. Normalization requires a listing size; fill percentages and fractions such as `50/100ml` are incorporated where supplied. Unknown fill uses the stated volume.

Reddit polling resumes after the previous persisted polling interval. Failed alerts are retried on subsequent successful polls, with one delivery per listing and chat even when multiple watches match. Price edits keep a stable listing identity. Store writes roll back in memory if persistence fails. Session-source health requires both recent readable posts and recent new-post discovery; refreshing old posts cannot hide a broken discovery feed. JSON becomes stale after three polling intervals; HTML allows at least one discovery cycle plus a polling interval. RSS uses three polling intervals since its last successful poll. Multi-price rows are skipped because individual prices cannot be assigned safely.

## Run locally

1. Use Node 20+ and copy `.env.example` to `.env`; paste in your Telegram bot token from @BotFather.
2. Run `npm run reddit:session-check` to save a session and verify discovery, a complete sale post, and listing parsing. A session already saved by this command can be reused.
3. Run `npm run reddit:json-check`, then set `REDDIT_SOURCE=json` in `.env`, then run `npm start`. Run one Telegram worker at a time. No browser needs to stay open.
4. Message the bot `/add aventus absolu under $180 min 90ml`. Optionally set `PORT=3000` for the dashboard and `/health`, `/api/listings`, and `/api/market` endpoints.

Startup claims a PID lock beside `STORE_FILE` before loading the store or polling.
A second worker using that store exits with the running worker's PID. Normal
shutdown releases the lock; a later startup recovers a lock left by a dead worker.
Use Ctrl+C to stop `npm start`: terminating only the npm parent can leave its
Node worker running. If Telegram reports a `getUpdates` conflict, stop the other
worker using the same token, including any deployment on another computer or
using another store. Conflicts wait at least 30 seconds before retrying, increase
to 60 seconds, and suppress repeated identical errors.

The JSON source reads the newest 25 complete posts in each feed request, including
full text, sold flair, and removal metadata. With the default interval, requests
are at least 90 seconds apart. When older active listings need a refresh, the bot
alternates feed batches and individual detail requests: new-post discovery is
then every 3 minutes. Failed discovery reads are retried after backoff before
resuming old-post refreshes. Without a refresh backlog, discovery is every 90 seconds.
A larger `POLL_INTERVAL_MS` increases these intervals. Active posts within 30 days
become eligible for refresh after 30 minutes; a backlog can delay their refresh.

Your display can be off; the computer must stay awake. Request timestamps and
checked posts persist across restarts. Complete snapshots update prices and sold
markers, retire missing rows, and preserve matching existing alert identities.
`REDDIT_SOURCE=html` remains available as a fallback, using the same session and
checkpoint. HTML discovers roughly every five minutes and queues individual
body reads; it is slower than JSON batch ingestion.

Run `npm test` for the automated checks.

### Save or renew your Reddit session

Open `https://old.reddit.com/r/fragranceswap/new/` in your normal signed-in browser.
If listings load, open DevTools → Network, reload, select the document request,
and copy the **Cookie** value from **Request Headers**. Paste it only into the
command's hidden local prompt. The session is stored in `data/reddit-session.txt`
with owner-only permissions and excluded from Git. Treat it like a password.
Close the browser after setup.

To replace an expired session, run:

```sh
npm run reddit:session-check -- --renew
```

Stop the bot before running a live check, to preserve request spacing. The HTML session check
uses the production HTTP reader and parser with an in-memory queue.
`npm run reddit:json-check` verifies JSON discovery and a full detail page,
persisting only request timestamps in the existing checkpoint. It saves no
listings and sends no Telegram messages. After renewal, restart `npm start` to
clear any previous failure backoff. The session file is reread before each
request. `REDDIT_HTML_COOKIE_FILE` can override the default path.

### Access and coverage

Authenticated JSON discovery and full-body reads were verified on this machine
on October 5, 2026. This adapts the saved-cookie JSON approach used by
[rdt-cli](https://github.com/public-clis/rdt-cli), the backend used by
[Agent Reach](https://github.com/Panniantong/Agent-Reach).
It calls ordinary `www.reddit.com` website JSON endpoints directly from Node,
without registering a Reddit API application, installing either project,
or keeping a browser open. There are no added package dependencies.
Reddit may expire the session, challenge requests, or change the endpoints.
Authentication errors back off; invalid responses do not retire stored listings.

If JSON discovery returns HTTP 403 while your signed-in browser still loads the
community, the saved-session HTML fallback may remain available. Stop the bot,
run `npm run reddit:session-check`, and, if discovery and the complete-post check
pass, set `REDDIT_SOURCE=html` in `.env` and restart. A 403 does not by itself prove
the session has expired. If the HTML check also fails, renew the session using
the hidden local prompt described above. Never paste session cookies into chat.

This is an unofficial website reader, not a guaranteed permanent feed. Reddit is
restricting Old Reddit access to moderators and recent users, as described in its
[infrastructure announcement](https://www.reddit.com/r/modnews/comments/1wubgvt/continuing_our_infrastructure_updates_whats/).
It discovers the newest 25 posts; long outages or more than 25 posts between
successful discovery reads can miss listings. HTML fallback body visits add queue delay
to alert delivery, and image-only listings without readable text cannot be
parsed. Matching repeated bottles after extensive edits can be ambiguous.

The legacy `REDDIT_SOURCE=rss` remains available while Reddit serves feeds.
Private RSS credentials use `REDDIT_RSS_USER` and `REDDIT_RSS_TOKEN`; the authenticated
sources ignore those settings. Existing environments without `REDDIT_SOURCE`
retain RSS for compatibility.

## Deployment notes

`data/store.json` is a safe, atomic single-instance store. Mount its parent directory as persistent storage and run exactly one worker with a bot token; Telegram long-polling permits a single update consumer. The schema is intentionally normalized around stable listing IDs so it can be migrated to PostgreSQL when operating multiple workers or retaining a much larger market archive.

For production, deploy behind private network access if the dashboard is enabled, alert on `/health` becoming stale, preserve the store in backups, and use a process manager that restarts the service. The monitor only considers `[WTS]` posts from the newest-posts window; long outages can exceed its discovery window. Historical backfill and multi-source ingestion require a separate source strategy.
