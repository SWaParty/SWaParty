# Cloudflare Pages Functions Integration

This folder contains a proxy template for the existing SWaParty Pages backend.

Copy:

```text
rmstate/integration/cloudflare/functions/api/rooms/[[path]].js
```

to:

```text
functions/api/rooms/[[path]].js
```

Then configure Pages environment variables:

```env
RMSTATE_BASE_URL=https://rmstate.example.com
RMSTATE_INTERNAL_API_TOKEN=CHANGE_ME_SAME_AS_SWAPPARTY_INTERNAL_API_TOKEN
```

The browser should call the same-origin API:

```text
/api/rooms
/api/rooms/{roomHash}
/api/rooms/{roomHash}/join
/api/rooms/{roomHash}/media
/api/rooms/{roomHash}/playback
/api/rooms/{roomHash}/messages
```

The proxy validates `swaparty_session` against D1 before forwarding to Spring.
