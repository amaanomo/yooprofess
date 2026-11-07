# Installing Orbit (Chrome developer mode)

Orbit isn't on the Chrome Web Store yet, so you install it from the code in this repo using Chrome's **developer mode**. It takes about 2 minutes, and you only do it once.

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

⚠️ **Keep this folder where it is.** Chrome loads Orbit straight from it. If you move or delete the folder, Orbit stops working.

---

## Step 2: Turn on developer mode

1. Open Chrome and go to **`chrome://extensions`** (type it into the address bar).
2. Turn on **Developer mode** with the switch in the **top-right corner**.

Three new buttons appear at the top: **Load unpacked**, **Pack extension** and **Update**.

---

## Step 3: Load Orbit

1. Click **Load unpacked**.
2. Go into the folder you downloaded and select the **`extension`** folder inside it. It's the folder that contains `manifest.json`.
   - ✅ `yooprofess/extension`
   - ❌ `yooprofess` (one level too high)
3. Click **Select**. (Windows: **Select Folder**.)

An **"Orbit: Lecture Tutor"** card now appears on the extensions page.

---

## Step 4: Pin Orbit to the toolbar (optional, recommended)

1. Click the **puzzle-piece icon** 🧩 to the right of the address bar.
2. Click the **pin** next to **Orbit: Lecture Tutor**.

Orbit's icon, a green planet, now stays in your toolbar. Click it to show or hide Orbit on a lecture.

---

## Step 5: Try it

1. Sign in to Panopto (for example through UBlearns or Canvas).
2. Open any recorded lecture. The address should look like
   `https://<school>.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=...`
3. The **Ask Orbit** card appears in the bottom-left corner, and after a moment it should say **"Loaded N caption lines"**.
4. Play the video. The header should read **"Following at M:SS"**.
5. Type a question, or tap one of the suggestion buttons.

It also works on Canvas pages that have a Panopto video embedded in them.

> Right now Orbit runs in **demo (stub) mode**: replies are sample answers, because the AI server isn't connected yet.

---

## Updating to a newer version

When the code changes:

1. Get the new code: download a fresh ZIP into the **same** folder, or run `git pull`.
2. Go to `chrome://extensions` and click the **↻ reload** icon on the Orbit card.
3. **Reload any open Panopto tabs.**

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You picked the wrong folder. Select the `extension` folder, the one that contains `manifest.json`. |
| Orbit doesn't appear on the lecture | **Reload the Panopto tab.** Tabs that were already open when you installed Orbit don't get it until they're reloaded. Also check that the address contains `panopto.com` and `Viewer.aspx?id=` or `Embed.aspx?id=`. |
| "You're not signed in to Panopto" | Sign in to Panopto in the same Chrome window, then click **Retry** on the message. |
| "This lecture doesn't have captions yet" | That recording has no captions. Try a different lecture. |
| Orbit was there, then disappeared | You may have clicked the toolbar icon, which hides it. Click the icon again. If Orbit is shrunk to a small round button in the corner, click that button to open it. |
| A red **Errors** button on Orbit's card in `chrome://extensions` | Click it, take a screenshot, and send it to the team. |
| Orbit stopped working after you moved the folder | Remove Orbit in `chrome://extensions`, then do Step 3 again with the new location. |

**Reporting a bug:** on the lecture page, press `Cmd+Option+J` (Mac) or `Ctrl+Shift+J` (Windows) to open the console. Type `[Orbit]` in the filter box and send a screenshot of those lines along with a screenshot of the Orbit card.

---

## Uninstalling

Go to `chrome://extensions` and click **Remove** on the Orbit card. You can delete the downloaded folder afterwards.
