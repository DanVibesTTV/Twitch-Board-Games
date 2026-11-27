# Session server (phone players on stream)

The session server lets viewers play your game from the **Stream Board Games** phone app. It runs on a computer that is always on (here: a mini PC at home) and only passes messages along:

```
your overlay (OBS) ──▶  session server  ◀── viewers' phones
```

The game itself still runs in your overlay. The server checks everyone's Twitch login, so the overlay knows who each phone belongs to, and stores nothing. It's very light: a small mini PC (Intel N100) handles hundreds of phones.

To reach it from the internet without opening router ports or showing your home IP address, it sits behind a **Cloudflare Tunnel** (free) on a domain you own, e.g. `https://games.danvibes.net`.

You need:
- a domain whose DNS is on Cloudflare (step 1),
- the mini PC running Windows 10/11, with the latest `StreamBoardGames-vX.Y.Z-windows-x64.zip` from the [releases](https://github.com/DanVibesTTV/Twitch-Board-Games/releases/latest) (no Node.js needed),
- about 30 minutes, most of it waiting for DNS.

---

## 1. Move the domain's DNS to Cloudflare

Use a domain that nothing important depends on (DanVibes: `danvibes.net`; `danvibes.me` stays untouched). The domain stays registered at Squarespace; only its DNS moves.

1. Create a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up), then **Add a domain** → `danvibes.net` → **Free** plan.
2. Cloudflare imports the existing DNS records. Keep them; they are what currently sends the domain to your merch page.
3. Cloudflare shows **two nameservers** (like `anna.ns.cloudflare.com`). In Squarespace: **Domains** → `danvibes.net` → **DNS** → **Domain nameservers** → **Use custom nameservers**, enter both, save.
4. Wait until Cloudflare emails you that the domain is **active** (usually minutes, at most a day).
5. Open `danvibes.net` in a browser. Still lands on your merch page? Done. If not, Squarespace was *forwarding* the domain (a Squarespace feature that stops working once the DNS moves). Recreate it in Cloudflare: **Rules → Redirect Rules → Create rule**, match all requests to the domain, redirect to your merch URL (301).

## 2. Run the session server on the mini PC

1. Extract the zip to a permanent folder, e.g. `C:\StreamBoardGames-Server`.
2. Test it once: open **Terminal** in that folder and run

   ```
   .\StreamBoardGames.exe --session-server
   ```

   It prints `Listening on http://127.0.0.1:8790`. Open that address in a browser on the mini PC: you should see *"Stream Board Games session server v… — 0 session(s)"*. (The first start may show *"Windows protected your PC"*: **More info → Run anyway**.) Close the terminal with **Ctrl+C**.

3. Start it automatically with Windows, even when nobody is logged in. Open **Terminal (Admin)** (right-click Start) and paste this as one block (adjust the folder if yours differs):

   ```powershell
   $dir = "C:\StreamBoardGames-Server"
   $action = New-ScheduledTaskAction -Execute "$dir\StreamBoardGames.exe" -Argument "--session-server" -WorkingDirectory $dir
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
   Register-ScheduledTask -TaskName "StreamBoardGames session server" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest
   Start-ScheduledTask -TaskName "StreamBoardGames session server"
   ```

   Check `http://127.0.0.1:8790` again: it should answer without any terminal open. (No time limit, restarts itself if it ever stops.)

4. Keep the mini PC awake: **Settings → System → Power → Screen, sleep & hibernate timeouts**: set *sleep* to **Never** when plugged in.

## 3. Connect it to the internet with a Cloudflare Tunnel

1. On the mini PC, install cloudflared in **Terminal**:

   ```
   winget install --id Cloudflare.cloudflared
   ```

2. In the Cloudflare dashboard open **Zero Trust** (first time: pick the free plan, no card needed for it) → **Networks → Tunnels** → **Create a tunnel** → type **Cloudflared** → name it e.g. `minipc`.
3. Cloudflare shows install commands. Choose **Windows**, copy the command that looks like `cloudflared.exe service install eyJ…` and run it in **Terminal (Admin)**. This makes cloudflared a Windows service that starts with the PC. The tunnel turns **Healthy** in the dashboard after a few seconds.
4. Add the route to the session server (called *Public hostname* or *Published application*, depending on the dashboard version):
   - **Subdomain:** `games`  **Domain:** `danvibes.net`
   - **Service type:** `HTTP`  **URL:** `localhost:8790`

   Save.
5. Test from your phone (on mobile data, not your WiFi): open **https://games.danvibes.net**. You should see the *session server* line from step 2.

## 4. Turn on phone players

- In the companion app's control panel (on your streaming PC): **Phone players** → tick **Let viewers join from the phone app**. The server address defaults to `https://games.danvibes.net`; change it under *Session server* if yours is different.
- The badge turns **on · 0 phones** once the overlay in OBS is connected.
- Viewers: **Stream Board Games** app → **📺 Join a stream** → your Twitch name → log in with Twitch once (a code to confirm on twitch.tv/activate) → tap **Join the game** in the lobby.

The lobby shows viewers how to join; in secret-card games like Texas Hold 'em it says *"Play on your phone"*, since chat viewers have nowhere private to see their cards.

---

## Updating

The session server changes rarely; release notes say when it needs an update. Then, on the mini PC:

```powershell
Stop-ScheduledTask -TaskName "StreamBoardGames session server"
# extract the new zip over C:\StreamBoardGames-Server
Start-ScheduledTask -TaskName "StreamBoardGames session server"
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Panel: *can't reach https://games.danvibes.net* | Open that URL in a browser. No answer → in Cloudflare, is the tunnel **Healthy**? Is the mini PC on? |
| The URL shows a Cloudflare error page (502/1033) | The tunnel works but the server doesn't: open `http://127.0.0.1:8790` on the mini PC; restart the task (`Start-ScheduledTask …`). |
| Panel: *open · overlay not connected* | The overlay hosts the phones: open it in OBS (or a browser) with `?bridge=node`. |
| A viewer gets *different versions* | Phone apps update themselves (close and reopen the app). If the phone is newer than you, install the companion update. |
| A viewer's Twitch login fails | They log in again from **Join a stream** (log out link there). |

Port: `StreamBoardGames.exe --session-server --port 8791` uses another port (then point the tunnel at it). Running from source instead: `node app/session-server.mjs` (Node.js 22+).
