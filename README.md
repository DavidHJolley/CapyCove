# Capy Cove

https://capycove.duckdns.org/

A cozy multiplayer hangout world in the browser. Waddle around five locations
as a chibi capybara, chat and dance with other players, earn coins in three
minigames, and spend them on hats. Three.js client, Node + WebSocket server,
zero external assets (everything is procedural: geometry, canvas textures,
WebAudio synth).

## Locations
- **Sunny Plaza**: central hub with the fountain and the hat shop
- **Driftwood Beach**: animated sea, dock, and the *Reel Rush* fishing game
- **Frosty Peak**: snowfall, chairlift, and the *Summit Sprint* sled racer
- **The Smoothie Shack**: tropical juice bar with *Smoothie Scramble*
- **Groove Grotto**: underground dance cave with an LED floor

## Multiplayer
- Real-time rooms over WebSocket (positions, chat, emotes, outfits)
- Guest play (progress on-device) or accounts (scrypt-hashed passwords,
  signed session tokens, coins/hats/best-scores persisted server-side)
- Server-authoritative coin payouts (per-game caps) and chat rate limits
- Ambient capybara bots so the cove never feels empty

## Documentation

- `CLAUDE.md`: agent/developer onboarding: scope, file ownership, rules
- `CONTRACT.md`: module interfaces (rooms, minigames, game API, protocol)
- `DESIGN.md`: art style and game design bible
- `docs/CARDGAME.md`: Capy Clash card duel spec

## Development
```bash
npm install
npm run dev:server   # game + auth server on :3001
npm run dev          # vite client on :5199 (proxies /api and /ws)
```

## Production
```bash
npm run build        # builds client to dist/
npm start            # serves dist/ + API + websockets on :3001 (or $PORT)
```
Player data lives in `data/` (flat JSON). Keep that directory on a persistent
disk. Config for three hosts is included: `Dockerfile` (anything that runs
containers), `render.yaml` (Render), `fly.toml` (Fly.io). Note: serverless
platforms without long-lived processes (e.g. Vercel functions) cannot host
the WebSocket server.
