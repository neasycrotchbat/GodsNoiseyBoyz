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
2. With `start.bat` running, double-click **`share.bat`** and leave its window open.
3. In the room, press **Invite friends** and copy the link. It has the password built in, so friends just open it, pick a name and a cat, and they're in. Only send it to people you want in the room; changing the password in `config.json` retires old invite links.

If Invite friends can't find the public address, paste the `.trycloudflare.com` address from the `share.bat` window into the box it shows. You can also send that address plus the password the old way.

That quick link changes every time you run `share.bat`. For a link that never changes, buy a cheap domain (about $10 a year), add it to a free Cloudflare account, and follow Cloudflare's "Create a remotely-managed tunnel" guide. It points a name like `room.yourdomain.com` at `http://localhost:3000` and runs as a Windows service, so you can skip `share.bat` entirely.

## How it works for everyone

- **Getting in:** open the link, enter the password, pick a username and a cat. The browser remembers you. Using the same username on another device picks up the same queue and points.
- **Building a queue:** in **My queue**, paste a YouTube song link and press Add. Drag songs to reorder (or use Top on a phone). Click songs to select several (shift-click selects a range), then move them to the top or bottom, remove them, or drag them together. Esc clears the selection. **Shuffle play** picks a random song from your queue each turn.
- **Playlists:** open the **Playlists** drawer at the bottom of My queue. Paste a YouTube playlist link there and press Import to save it (no API key needed, up to about 200 songs). Your queue is the top row; press **Load** on any playlist to make it your queue, or **Save as playlist** to keep the queue you've built. Everyone in the room can load everyone's playlists.
- **No pausing:** the video can't be paused or clicked, so everyone stays in sync. Use **Mute** or the volume slider for your own speakers.
- **DJing:** take an open seat at the booth. DJs take turns, one song each. The song you play is marked **Played** and moves to the bottom of your queue; only unplayed songs come up on your turns. When you've played everything, you leave the decks automatically. Add songs, load a playlist, or press **Replay all** to go again.
- **Voting:** Awesome makes your cat dance and gives the DJ a point. If enough people vote Lame (at least 2, and at least half the room), the song gets skipped.
- **Snag:** copies the current song into your own queue.
- **Alerts:** tick "Desktop alerts" in Chat to get a notification when someone @mentions you or a new song starts while the tab is in the background.

## Optional: YouTube API key (playlist import and search)

Single links and playlist import work without this. To search YouTube from inside the room, import playlists over 200 songs, and see song lengths up front, add a free API key:

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
| `crowd` | NPC cats on the dance floor, default 24 (0 turns them off, 40 max). Narrow screens show fewer. |

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

Each cat is a sprite atlas in `public/cats/`: 64×88 frames, 32 to a row, with one block of rows per view (front, side, back). Every avatar has the same clips: ten dance moves (Swing step, Side shuffle, Knee-up groove, Elbow bounce, Party stomp, The twist, Disco point, Raise the roof, Hands in the air, The robot), reactions (cheer, jump, clap) and resting loops (head bob, idle). `public/cats/cats.json` lists where each clip starts and how fast it plays.

`public/dance.js` is the dance director. While a song plays, the DJ and anyone who voted Awesome string moves together, switching every few seconds, turning to the side or back, and sometimes spinning. Everyone else bobs along, and between songs they idle and look around. The whole room jumps and cheers when a new song starts and claps when the music stops. The choices come from the song's start time and each person's ID, so every friend sees the same dancing. Each cat favours its signature move. Changing moves is tweened: every clip has a few eased frames out to a shared "ready" stance and back in, so a cat settles out of one move, turns there if it's changing direction, and eases into the next.

There are sixteen avatars to pick from.

- **Eleven cats:** Biscuit, Smokey, Midnight, Pepper, Mochi, Ginger (tabby in a scarf), Snowball (white, with a daisy), Ash (blue-gray in a bow tie), Tortie (tortoiseshell in a beanie), Bengal (spotted, in a party hat) and Cocoa (chocolate in shades). Their special: tails swing with the beat.
- **Five robots:** Boxy (CRT head, twin antennas), Pixel (TV head with a smiley screen), Tidy (a retro maid bot on a wheel), Jet (hovers on a thruster) and Endo (a chrome endoskeleton). Their special: lights pulse on the beat (antenna tips, eyes, visors, Jet's thruster flame) and antennas pump up and down. Robots favour a staccato move of their own, The robot.

Robots are drawn on the same skeleton as the cats (`draw_robot` in `make_cats.py`, built from a head, a torso and legs, a wheel or a thruster), so every move works for them too.

**The stage:** the video fills the width of the stage, with the DJ booth standing in front of its lower edge, so the DJs dance in front of the big screen.

**The crowd:** the dance floor is a concert crowd seen from behind, facing the DJ booth: three rows of big cats, the back rows' heads over the decks and the front row cut off at the waist. They turn around to face you now and then mid-dance. Real people stand in the front row with their names over their heads (yours in amber); NPC cats fill in around and behind them, dimmer the further back they are. Everyone sees the same crowd. They bob along during songs and cheer when a new one starts; the more Awesome votes a song gets, the more of them dance, and Lame votes calm them down. The whole scene scales to the width of the screen.

## Regenerating the cat art

The cats are drawn by `tools/cats/make_cats.py` (needs Python 3 and Pillow: `pip install pillow`). Moves are keyframes on a shared skeleton, written as seen from the front; the script draws them from all three views, so a new move works for every cat. Run it (about 40 seconds), and it writes atlases, `cats.json`, GIF previews (`gifs/<cat>_moves.gif`, `gifs/<cat>_turn.gif`) and a lineup into `tools/cats/out/`. Copy `tools/cats/out/sprites/*.png` and `tools/cats/out/cats.json` into `public/cats/` to use them in the room. Pass cat ids (`python tools/cats/make_cats.py biscuit`) to redraw just those for a quick preview.
