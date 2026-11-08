# Installing Nova (Chrome developer mode)

Nova isn't on the Chrome Web Store yet, so you install it from the code in this repo using Chrome's **developer mode**. It takes about 2 minutes, and you only do it once.

You need Google Chrome. Microsoft Edge and Brave work the same way.

---

## Step 1: Get the code

Choose **one** of these:

**Option A: Download a ZIP (no Git needed)**

1. Go to https://github.com/amaanomo/yooprofess
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it somewhere you'll keep it, such as your Documents folder.

**Option B: Git**

```bash
git clone https://github.com/amaanomo/yooprofess.git
```

⚠️ **Keep this folder where it is.** Chrome loads Nova straight from it. If you move or delete the folder, Nova stops working.

---

## Step 2: Turn on developer mode

1. Open Chrome and go to **`chrome://extensions`** (type it into the address bar).
2. Turn on **Developer mode** with the switch in the **top-right corner**.

Three new buttons appear at the top: **Load unpacked**, **Pack extension** and **Update**.

---

## Step 3: Load Nova

1. Click **Load unpacked**.
2. Go into the folder you downloaded and select the **`extension`** folder inside it. It's the folder that contains `manifest.json`.
   - ✅ `yooprofess/extension`
   - ❌ `yooprofess` (one level too high)
3. Click **Select**. (Windows: **Select Folder**.)

An **"Nova: Lecture Tutor"** card now appears on the extensions page.

---

## Step 4: Pin Nova to the toolbar (optional, recommended)

1. Click the **puzzle-piece icon** 🧩 to the right of the address bar.
2. Click the **pin** next to **Nova: Lecture Tutor**.

Nova's icon, a green planet, now stays in your toolbar. Click it to show or hide Nova on a lecture.

---

## Step 5: Try it

1. Sign in to Panopto (for example through UBlearns or Canvas).
2. Open any recorded lecture. The address should look like
   `https://<school>.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=...`
3. The **Ask Nova** card appears in the bottom-left corner, and after a moment it should say **"Loaded N caption lines"**.
4. Play the video. The header should read **"Following at M:SS"**.
5. Type a question, or tap one of the suggestion buttons.

It also works on Canvas pages that have a Panopto video embedded in them.

> Right now Nova runs in **demo (stub) mode**: replies are sample answers, because the AI server isn't connected yet.

---

---

## Step 6: Turn on voice ("Hey Nova")

The settings page opens automatically after install. You can also right-click the Nova icon and choose **Options**.

1. Open a Panopto lecture. Chrome asks **"…panopto.com wants to use your microphone"**. Click **Allow**; you only do this once. Nova listens for "Hey Nova" on the lecture tab while it's open and visible, using Chrome's speech recognition, so no account or key is needed.
2. If you missed the prompt or blocked it, click the mic icon in the address bar, choose **Allow**, and reload the lecture.
3. Pick a **voice** and click **Preview**. The default **Auto** engine uses ElevenLabs for Nova's English voice (spoken answers and whiteboard lessons, built-in voice Brian unless you pick another) and to transcribe your questions, when the server has `ELEVENLABS_API_KEY`. It falls back to Chrome's free voices and speech recognition when it doesn't or when ElevenLabs fails. Pick **Free** to always use Chrome. Other languages (answers, whiteboard lessons and dubbing in your subtitle language) always use Chrome's voices. Whiteboard lessons are taught in the subtitle language you picked.
4. The wake word status should read **Ready: listens on your lecture tab**. Now open a lecture and say *"Hey Nova, what did she just say?"* (*"Yo Nova"* works too).

Voice commands work in natural phrasing ("can you…", "please…") and can be combined with "and"/"then":
- **Play/pause:** *"can you pause the video"*, *"resume"*, *"keep going"*
- **Skip:** *"go back 30 seconds"*, *"skip ahead 2 minutes"*, *"rewind a bit"*, *"replay the last 10 seconds"*
- **Jump:** *"skip to 12:30"*, *"go to minute 5"*, *"start over"*, *"go to where he talks about recursion"*
- **Speed/volume:** *"play at 1.5x"*, *"slow down"*, *"normal speed"*, *"mute"*, *"turn it down"*
- **Combined:** *"go back 30 seconds and play"*

"Hey Nova" pauses the video, and it stays paused until you say *play* or *resume*. Asking *"where did he talk about X?"* gives clickable timestamps. The 🔊 button in Nova's header switches between spoken answers and text only.

---

## Updating to a newer version

When the code changes:

1. Get the new code: download a fresh ZIP into the **same** folder, or run `git pull`.
2. Go to `chrome://extensions` and click the **↻ reload** icon on the Nova card.
3. **Reload any open Panopto tabs.**

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You picked the wrong folder. Select the `extension` folder, the one that contains `manifest.json`. |
| Nova doesn't appear on the lecture | **Reload the Panopto tab.** Tabs that were already open when you installed Nova don't get it until they're reloaded. Also check that the address contains `panopto.com` and `Viewer.aspx?id=` or `Embed.aspx?id=`. |
| "You're not signed in to Panopto" | Sign in to Panopto in the same Chrome window, then click **Retry** on the message. |
| "This lecture doesn't have captions yet" | That recording has no captions. Try a different lecture. |
| Nova was there, then disappeared | You may have clicked the toolbar icon, which hides it. Click the icon again. If Nova is shrunk to a small round button in the corner, click that button to open it. |
| "Hey Nova" does nothing | Open Nova's settings and check the wake word **Status**. It tells you what's wrong (usually the microphone). If a pinned "Nova is listening" tab opened, keep it open. Nova can't open on `chrome://` pages or the Web Store. |
| Nova answers but doesn't speak | Make sure the 🔊 button in Nova's header is on. Nova only speaks answers to questions you *asked out loud*. |
| A red **Errors** button on Nova's card in `chrome://extensions` | Click it, take a screenshot, and send it to the team. |
| Nova stopped working after you moved the folder | Remove Nova in `chrome://extensions`, then do Step 3 again with the new location. |

**Reporting a bug:** on the lecture page, press `Cmd+Option+J` (Mac) or `Ctrl+Shift+J` (Windows) to open the console. Type `[Nova]` in the filter box and send a screenshot of those lines along with a screenshot of the Nova card.

---

## Uninstalling

Go to `chrome://extensions` and click **Remove** on the Nova card. You can delete the downloaded folder afterwards.
