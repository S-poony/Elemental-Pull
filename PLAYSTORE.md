# Publishing Elemental Pull on Google Play

The plan is to ship the existing web build as a **Trusted Web Activity** (TWA): an Android app whose entire UI is this site, rendered by the user's Chrome engine with no browser chrome around it. Nothing is rewritten, the game stays one codebase, and web releases go out without a store review — a store release is only needed when the native shell changes.

The tooling is [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), Google's own CLI for generating the shell.

---

## Where this repo already stands

Done, in this branch:

- **Web app manifest** — `public/manifest.webmanifest`, with name, colours, `display: standalone` and the icon set. Bubblewrap reads this file to seed everything about the Android build, so it is the source of truth for the app's identity.
- **Icons** — `public/icons/`, regenerate with `node scripts/make-icons.mjs`. Includes a 512×512 maskable variant, which Android needs to fit the icon to whatever launcher shape the device uses; ship without it and the icon gets letterboxed inside a white blob.
- **Service worker** — `public/sw.js`, network-first for navigations and cache-first for fingerprinted assets. This is what makes the game playable offline and installable.
- **Mobile viewport** — `dvh`-based layout, safe-area insets, no pull-to-refresh, no double-tap zoom delay.

Still to do, in order:

---

## 1. Settle the origin — do this before anything else

This is the one decision that is expensive to change later, because the app's identity on Play is tied to it.

A TWA proves it owns its website through **Digital Asset Links**: a file that must be served from

```
https://<origin>/.well-known/assetlinks.json
```

**The origin root — never a subpath.** That is the whole problem with the current hosting. GitHub Pages serves this repo as a *project site* at `https://s-poony.github.io/Elemental-Pull/`, so the origin is `s-poony.github.io`, and the file has to land at `https://s-poony.github.io/.well-known/assetlinks.json` — which is served by the separate `S-poony.github.io` *user site* repo, not by this one. Nothing this repo deploys can put a file there.

Three ways out, best first:

| Option | What it costs | What you get |
| --- | --- | --- |
| **Custom domain** (e.g. `elementalpull.com`) on GitHub Pages | ~£10/yr, one CNAME, one DNS record | Own origin, own asset links, a real name on the store listing. Recommended. |
| **User site repo** — move the game to `S-poony.github.io` | Free, but that repo becomes the game | Asset links at the root work. Every other page on that domain is also verified for the app. |
| **`.well-known` in the user site repo**, game stays here | Free | Works, but verification lives in a repo unrelated to the app, which is easy to forget and break. |

If you take the custom domain, point `vite.config.ts`'s `base` back to `/` for that deploy (the current logic sets a subpath whenever it runs under Actions), set the domain in the Pages settings, and wait for the certificate before continuing.

> Worth knowing: an app that has to be verified against a domain you don't control is exactly the situation Capacitor exists for — see *Alternatives* at the bottom.

---

## 2. Get a Play Console account

- **$25, one time, non-refundable.** <https://play.google.com/console/signup>
- **Identity verification is mandatory** and takes days, not minutes — a personal account needs a government ID and an address that Google can confirm. Start this while you work on everything else.
- Choose **personal vs organisation** deliberately. It decides whether step 8 applies to you, and it cannot be changed afterwards without creating a new account.

---

## 3. Verify the PWA passes its own checks

Before wrapping it, confirm the thing being wrapped is sound. From a deployed URL, not localhost:

```bash
npx lighthouse https://<your-origin>/ --view --preset=desktop
```

What has to be true: served over HTTPS, manifest with a 512×512 icon, a registered service worker, and the page usable offline. If the installability audit fails, Bubblewrap will still build something, but it will be a browser window with no address bar rather than an app.

Also worth a manual pass on a real phone: install it from Chrome's "Add to home screen" and play a round from the installed icon. That is exactly what the TWA will feel like.

---

## 4. Generate the Android shell

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://<your-origin>/manifest.webmanifest
```

It will ask, and these are the answers that matter:

- **Application ID** — reverse-DNS, permanent, cannot ever be changed once published. Something like `com.spoony.elementalpull`. Do not leave the `com.example` default.
- **App name** — `Elemental Pull` (Play titles cap at 30 characters).
- **Launcher name** — what fits under the icon on a home screen; keep it to about 12 characters or Android truncates it. `Elemental` reads better there than a clipped `Elemental Pu…`.
- **Display mode** — `standalone`.
- **Orientation** — the layout handles both now, so `default` is fine; pick `portrait` if you would rather force it.
- **Signing key** — let it generate one, then **back the keystore and its passwords up somewhere you will still have in five years**. Losing it means you can never update the app under the same listing. Opting into Play App Signing (step 6) reduces but does not remove this exposure.

Then:

```bash
bubblewrap build      # produces app-release-bundle.aab and app-release-signed.apk
bubblewrap install    # side-load the APK onto a connected device
```

**Check for a URL bar at the top of the running app.** If one is there, asset link verification failed — the app is falling back to a plain browser view. That is the single most common TWA problem and step 5 is the fix.

---

## 5. Publish the asset links file

Get the fingerprint of the key that will actually sign what users install:

```bash
bubblewrap fingerprint list
```

Serve this at `https://<your-origin>/.well-known/assetlinks.json` — for a GitHub Pages site, commit it under `public/.well-known/` so Vite copies it into `dist/`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.spoony.elementalpull",
      "sha256_cert_fingerprints": ["<SHA-256 from bubblewrap, colon-separated hex>"]
    }
  }
]
```

**The trap:** once you enable Play App Signing, Google re-signs your upload with *their* key, so the fingerprint that ends up on users' devices is not the one you just printed. After the first upload, take the SHA-256 from **Play Console → Test and release → App integrity → App signing key certificate** and add it to the array. Keeping both fingerprints listed lets your local side-loaded builds and the store build both verify.

Verify with Google's checker once it is live:

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<your-origin>&relation=delegate_permission/common.handle_all_urls
```

---

## 6. Prepare the store listing

Assets, all of which need making:

- **App icon** — 512×512 32-bit PNG. `public/icons/icon-512.png` is exactly this.
- **Feature graphic** — 1024×500 PNG/JPEG, no transparency. Shown at the top of the listing; there is no way to skip it.
- **Phone screenshots** — at least 2 (up to 8), 16:9 or 9:16, shortest side ≥ 320px. Grab these from a real device mid-cascade, with a decent score on the HUD; a screenshot of an empty board sells nothing.
- **Short description** — ≤ 80 characters. e.g. *"Drop tiles, watch them pull each other, and score the chain reaction."*
- **Full description** — ≤ 4000 characters. The rules section of `README.md` is most of it already.

Declarations, all mandatory:

- **Privacy policy URL** — required even though the game collects nothing. Host a short page on the same domain saying exactly that: no accounts, no analytics, no network calls, high score kept in the browser's own storage on the device.
- **Data safety form** — declare no data collected and no data shared. It must match the privacy policy, and it must stay true if you ever add analytics.
- **Content rating questionnaire** (IARC) — free, a few minutes, and the listing cannot go live without it.
- **Target audience and ads** — no ads, and pick the age bracket honestly. Declaring an audience under 13 pulls in a much stricter policy set (Families policy, COPPA), so don't do it unless you mean it.

---

## 7. Technical requirements to confirm

- **AAB, not APK** — Play requires the App Bundle for new apps. `bubblewrap build` emits one.
- **Target API level** — Play enforces a rolling floor: new apps must target an API level within one year of the newest Android release, and the cutoff moves every August. Bubblewrap's generated `build.gradle` is usually current, but check it against the [current requirement](https://developer.android.com/google/play/requirements/target-sdk) before you upload rather than after a rejection.
- **Version codes** — every upload needs a higher `versionCode` than the last. `bubblewrap update` bumps it; forgetting is a rejected upload, not a broken app.

---

## 8. Testing tracks — the part that takes the longest

For **personal developer accounts created after 13 November 2023**, Google requires a closed test with **at least 12 testers opted in, continuously, for 14 days** before you may even apply for production access. Organisation accounts are exempt. This is a wall-clock delay of two weeks *minimum* on top of everything above, and the counter resets if testers drop below twelve — line up more than twelve people before you start. (Policy details shift; confirm the current rule in the Console before planning around it.)

The route:

1. **Internal testing** — up to 100 testers by email, available immediately, no review wait. Use this to check the signed build off the store.
2. **Closed testing** — the 12-tester, 14-day clock above.
3. **Apply for production access** — a questionnaire about the app and how testing went.
4. **Production** — first review typically takes a few days and can take longer.

---

## 9. After launch

Web content updates need **no store release**: push to `main`, Pages deploys, the service worker picks it up on next launch. Bear in mind installed players are on the cached build until then, which is exactly why `sw.js` is network-first for navigations.

A new store release is only needed for changes to the shell itself — app name, icon, orientation, target SDK, or the manifest fields Bubblewrap baked in. Then it is `bubblewrap update && bubblewrap build`, and upload.

---

## Alternatives

**PWABuilder** (<https://www.pwabuilder.com>) — the same TWA output through a web UI instead of a CLI. Worth using if the Bubblewrap install (it wants a JDK and the Android SDK) turns into a fight; the asset-links requirement is identical.

**Capacitor** — bundles the built `dist/` *inside* the APK and renders it in a WebView. No domain, no asset links, no hosting dependency at all, and it works offline from first launch. The costs: every content update needs a store release and its review wait, and you own a native project in the repo. If step 1's domain question stalls, this is the way around it.

**Not recommended: a plain WebView wrapper.** Play policy rejects apps that are just a browser pointed at a website with no added value. A TWA is explicitly sanctioned; a hand-rolled WebView shell is the thing the policy is aimed at.
