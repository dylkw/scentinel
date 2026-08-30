# Sillage — r/fragranceswap Telegram monitor

This is a standalone service script, not a website. Message the Telegram bot to create keyword alerts. When a new post in `r/fragranceswap` contains a keyword, the bot sends its Reddit link to the same chat.

## Commands

```text
/add aventus absolu
/list
/remove aventus absolu
/stop
/help
```

Matching is case-insensitive against the title and self-text, but alerts only fire for posts whose title includes `[WTS]` and does not include `decant`. When a dollar price appears in the same paragraph as the matched phrase, the alert includes it as the Reddit price. A subscriber can have multiple phrases.

## Run locally

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and save the token it gives you.
2. Use Node 20+ and copy `.env.example` to `.env`; paste in `TELEGRAM_BOT_TOKEN`. The start commands load that file automatically.
3. Run `npm start`. Keep this process running on any persistent machine or server.
4. Open your bot in Telegram, press **Start**, then send `/add aventus absolu`.

The bot polls Telegram for commands and Reddit's public Atom/RSS feed every minute by default. Set `POLL_INTERVAL_MS` to adjust that interval (for example, `30000` for 30 seconds). RSS needs no Reddit API credentials, but Reddit can still restrict access from a particular hosting network.

## Notes for production

`data/store.json` is suitable for one persistent instance. Move the `Store` class to a real database before deploying to multiple instances or ephemeral/serverless storage. Run exactly one copy of this bot, since Telegram long polling supports one active update consumer per bot token.
