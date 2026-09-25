# REACHRIGHT support chat (GitHub + Firebase)

A support chat for **site admins inside the WordPress dashboard**. Website visitors never see it.

- **GitHub Pages** hosts the files: the chat script, a test page, and the admin page.
- **Firebase (Firestore)** stores the answers and the tickets. Edit answers once in the admin page and every website updates.
- `kb.json` is a backup: if Firebase can't be reached, the chat answers from it.

| File | What it's for |
|---|---|
| `index.html` | Test page with the chat running |
| `admin.html` | Sign in with Google, edit answers, publish to Firebase, see recent tickets |
| `support-chat.js` | The chat (loaded by every website) |
| `firebase-config.js` | Your Firebase settings (fill in once) |
| `firestore.rules` | Security rules to paste into Firebase |
| `kb.json`, `kb.js` | Backup copy of the answers |
| `wordpress-plugin/zd-support-chat.zip` | Optional WordPress plugin |

> **Privacy:** GitHub Pages sites are public. Don't add files with ticket data (such as the offline `builder.html` with preloaded tickets) to this repository.

---

## Part 1: Set up Firebase (about 15 minutes)

1. Go to **console.firebase.google.com** → **Add project** (for example `reachright-support`).
2. **Firestore:** Build → **Firestore Database** → **Create database** → choose a location → start in **production mode**.
3. **Security rules:** Firestore → **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**.
4. **Sign-in:** Build → **Authentication** → **Get started** → enable **Google**.
5. **Admins:** Firestore → **Data** → **Start collection** named `admins` → add a document whose **Document ID is your Google email** (for example `jay@reachrightstudios.com`) with any field, such as `role: admin`. Repeat for each person who should edit answers.
6. **Web app settings:** Project settings (gear icon) → **Your apps** → **Web** (`</>`) → register an app → copy `apiKey`, `authDomain`, `projectId` and `appId` into `firebase-config.js`.

### Ticket emails (optional but recommended)
The chat saves each ticket in Firestore (`mail` collection); you can always see them in `admin.html`. To also **email** them to support@reachrightstudios.com:

1. Upgrade the project to the **Blaze** plan (pay as you go; normal chat use stays within the free allowance).
2. Extensions → install **Trigger Email from Firestore**.
3. Set the collection to `mail` and enter an SMTP connection (for example a Google Workspace app password or a SendGrid key).

Without the extension, tickets are still saved and visible in the admin page, just not emailed. WordPress sites using the plugin email tickets from the site itself and don't need this.

---

## Part 2: Put the files on GitHub (about 5 minutes)

1. Create a repository on github.com, for example `reachright-support-chat` (**public**; GitHub Pages is free for public repos).
2. **Add file → Upload files** → drag in everything from this folder (including `firebase-config.js` with your values) → **Commit**.
3. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → **Save**.
4. After a minute your site is live at `https://YOUR-GITHUB-NAME.github.io/reachright-support-chat/`.
5. Back in Firebase: Authentication → **Settings → Authorized domains** → **Add domain** → `YOUR-GITHUB-NAME.github.io` (needed for Google sign-in on the admin page).

## Part 3: Publish the answers

1. Open `https://YOUR-GITHUB-NAME.github.io/reachright-support-chat/admin.html`.
2. **Sign in with Google** (with an email you added to `admins`).
3. The first time, the 61 starter answers are loaded. Review them and click **Publish to Firebase**.
4. Open `index.html` on your GitHub site: "Answers loaded from" should say **Firebase**.

From now on, edit in `admin.html` and click **Publish**. Every publish also saves a backup copy in `kb_versions`. To roll back, copy an older version's `json` field into `kb/current` in the Firebase console.

---

## Part 4: Add the chat to websites

**Any website:** add before `</body>`:

```html
<script src="https://YOUR-GITHUB-NAME.github.io/reachright-support-chat/support-chat.js"
        data-firebase-project="rr-chat-support"
        data-firebase-key="AIzaSyDJaO0kBPTMBeTgyy_-DAe8gIQ_H2SCFv8"
        data-kb="https://YOUR-GITHUB-NAME.github.io/reachright-support-chat/kb.json"
        data-support-email="support@reachrightstudios.com"
        data-ticket-endpoint="firebase"
        defer></script>
```

**WordPress (plugin):** install `wordpress-plugin/zd-support-chat.zip` once on each site and activate it. That's all: the plugin has **no settings page**. The Firebase connection, support email, GitHub update address and "administrators only" are built into the plugin, so client admins can't change them. The chat appears only in the dashboard for administrators.

The plugin also carries a backup copy of the answers (`assets/kb.json`), used if Firebase can't be reached. It's refreshed each time you release a plugin update.

Non-WordPress sites load `support-chat.js` from GitHub, so updating that file updates them. WordPress sites get changes through plugin updates (below).

## Good to know
- Each visitor reads the answers once per visit (saved for 10 minutes), so Firestore's free allowance (50,000 reads a day) covers a lot of traffic.
- After publishing, sites show the new answers within about 10 minutes.
- The Firebase API key in `firebase-config.js` is meant to be public. The security rules decide what anyone can do: read answers, create ticket emails to your support address only, and nothing else unless they're an admin.
- For extra protection against automated abuse, you can turn on Firebase **App Check** later.

---

## Releasing a plugin update

Each WordPress site checks GitHub for a new version every few hours. To release one:

1. Get the new plugin zip (for example from Claude). Its version number must be higher than the current one, e.g. 1.1.0 → 1.2.0.
2. On GitHub, open the `wordpress-plugin` folder → **Add file → Upload files** → upload the new `zd-support-chat.zip` (it replaces the old one) → **Commit changes**.
3. Open `wordpress-plugin/update.json` → click the **pencil** → change `"version"` to the new number (and the date and changelog if you like) → **Commit changes**.
4. Wait a minute for GitHub Pages to update.
5. On a WordPress site: **Dashboard → Updates → Check again**. "Support Chat" appears; click **Update Plugins**. (Or wait: sites find it on their own within about 6–12 hours.)

The version in `update.json` must match the version inside the zip; otherwise WordPress keeps offering the same update.
