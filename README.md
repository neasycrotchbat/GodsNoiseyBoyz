# God's Noisey BoyZ

A private turntable.fm-style listening room for you and your friends. Up to five people sit at the DJ booth and take turns playing songs from their YouTube queues. Everyone hears the same thing at the same time, votes Awesome or Lame, snags songs they like, and chats.

## First-time setup (Windows)

1. **Install Node.js.** Get the LTS version from https://nodejs.org and run the installer with the default options.
2. **Unzip this folder** somewhere permanent, like `C:\NoiseyBoyz`.
3. **Double-click `start.bat`.** The first run opens `config.json` in Notepad. Change `"password"` from `changeme` to your room password, save, and close Notepad.
4. **Double-click `start.bat` again.** It installs what it needs (one time only) and starts the room. Leave this window open.
5. **Check it works:** open http://localhost:3000 on the PC.

## Letting your friends in

The room runs on your PC, so friends need a link that reaches it. The free way is a Cloudflare tunnel, which doesn't require opening ports on your router.

1. Open PowerShell and run `winget install --id Cloudflare.cloudflared` (one time only).
2. With `start.bat` running, double-click **`share.bat`**.
3. Copy the address ending in `.trycloudflare.com` and send it to your friends along with the password.

That quick link changes every time you run `share.bat`. For a link that never changes, buy a cheap domain (about $10 a year), add it to a free Cloudflare account, and follow Cloudflare's "Create a remotely-managed tunnel" guide. It points a name like `room.yourdomain.com` at `http://localhost:3000` and runs as a Windows service, so you can skip `share.bat` entirely.

## How it works for everyone

- **Getting in:** open the link, enter the password, pick a username and a cat. The browser remembers you. Using the same username on another device picks up the same queue and points.
- **Building a queue:** in **My queue**, paste a YouTube link and press Add. Drag songs to reorder.
- **DJing:** take an open seat at the booth. DJs take turns, one song each. The song you play moves to the bottom of your queue, like the original turntable.fm.
- **Voting:** Awesome makes your cat dance and gives the DJ a point. If enough people vote Lame (at least 2, and at least half the room), the song gets skipped.
- **Snag:** copies the current song into your own queue.
- **Alerts:** tick "Desktop alerts" in Chat to get a notification when someone @mentions you or a new song starts while the tab is in the background.

## Optional: YouTube API key (playlist import and search)

Single links work without this. To import whole playlists and search YouTube from inside the room, add a free API key:

1. Go to https://console.cloud.google.com, create a project, then open **APIs & Services > Library** and enable **YouTube Data API v3**.
2. Open **APIs & Services > Credentials**, choose **Create credentials > API key**, and copy it.
3. Paste it into `config.json` as `"youtubeApiKey": "your-key-here"` and restart `start.bat`.

The free quota covers about 100 searches a day plus thousands of song lookups, which is plenty for a friend group. With a key, songs also get their exact length up front and unplayable songs are filtered out when you add them.

## Settings (`config.json`)

| Setting | What it does |
| --- | --- |
| `password` | The room password everyone types once. |
| `siteName` | The name on the neon sign. |
| `port` | Local port, default 3000. If you change it, change `share.bat` too. |
| `youtubeApiKey` | Optional, see above. |
| `maxDjs` | DJ seats at the booth, default 5. |
| `lameSkipFraction` | Share of listeners whose Lame votes skip a song, default 0.5. |

Restart `start.bat` after changing settings.

## Good to know

- **Some videos won't play.** Some labels block their videos from playing outside youtube.com. The room skips them automatically and marks them in your queue.
- **Phones:** the room works in a phone browser, but music pauses if you switch apps or lock the screen. That's a phone browser rule, not something the site can change.
- **One click to start:** browsers block sound until you click, so everyone presses "Join the party" when they arrive.
- **The video stays on screen.** YouTube requires the player to be visible, so it's the big screen above the booth.
- **Your data** (queues, play history, points, recent chat) lives in the `data` folder. Back it up if you care about it. Delete `data\db.json` to start fresh.

## Starting automatically with Windows

Press `Win + R`, type `shell:startup`, and press Enter. Right-click in that folder, choose **New > Shortcut**, and point it at `start.bat`. Do the same for `share.bat` if you use the quick link. If you set up a permanent Cloudflare tunnel, it already runs as a service.

## Changing the cats

Each cat is a 288×56 sprite sheet in `public/cats/`: six 48×56 frames, where frames 1–4 are the dance and 5–6 are the idle sway. Replace a PNG with your own art at the same size and it shows up right away. To add a new cat, add its sheet and an entry to `public/cats/cats.json`.

## Regenerating the cat art

The cats are drawn by `tools/cats/make_cats.py` (needs Python 3 and Pillow: `pip install pillow`). Run it, and it writes sprite sheets, GIF previews and a lineup into `tools/cats/out/`. Copy the sheets from `tools/cats/out/sprites/` into `public/cats/` to use them in the room.
