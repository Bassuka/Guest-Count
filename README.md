# Door Count

One QR code goes on every invitation. Each scan at the door adds people to a live total, and the same code can be scanned again and again, so a family can come in on one invitation.

## Deploy (do this exactly)

This version needs a small backend, so it cannot be deployed by dragging a folder onto Netlify. Use GitHub or the Netlify CLI.

**Important:** `netlify.toml` must sit at the top level of your repository, next to the `public` and `netlify` folders. If it is inside another folder, Netlify shows "Page not found". This zip has no extra outer folder, so unzip it and upload its contents as they are.

**With GitHub (works from a phone browser)**
1. Create a GitHub repository and upload everything from this zip, keeping the folders.
2. In Netlify: Add new site, Import an existing project, pick the repository. Leave the build command empty.
3. Before the first deploy open Site configuration, Environment variables, and add:
   - `ADMIN_PIN` : your admin PIN (required)
   - `STAFF_PIN` : a second PIN for door staff (optional; staff can count, undo and read the log, nothing else)
4. Deploy. If you add or change a PIN later, trigger a new deploy.

If the site still says "Page not found", open Site configuration, Build & deploy, Build settings and check that Publish directory is `public`, and that Base directory is empty.

**With the CLI**
```
npm install
npm install -g netlify-cli
netlify login
netlify init
netlify env:set ADMIN_PIN "your-admin-pin"
netlify env:set STAFF_PIN "your-door-pin"
netlify deploy --prod
```

Use PINs of 8 or more characters. A wrong PIN is slowed by half a second, but there is no lockout.

## Before the event

1. Log in with the admin PIN, open **Setup**, enter the event name and the number of people you expect.
2. Open **Card**, upload your invitation picture, tap or drag to place the QR, and press **Save invitation picture**. Send that one picture to every guest. The page runs a readability check, so you will see if the QR cannot be scanned on your artwork.
3. Test it: scan the saved picture at the **Door** tab, then press **Reset count to zero** in Setup.

## At the door

- Open the site on each phone, log in (use the staff PIN for helpers) and open **Door**. All phones show the same live total.
- Press **Start camera** and show the QR. A high tone and a green panel mean the person was counted.
- **Family:** either scan once per person, or choose the family size first (1 to 6, or use + and minus) and scan once. After a count the size goes back to 1 unless you tick "Keep this number".
- To count the next person with the camera, move the code out of view and back in. Holding it still counts only once, so nobody is counted twice by accident.
- **Undo last count** removes the last scan, including a whole family.
- If the phone loses its connection, the panel says "Not confirmed". Tap **Retry now** and do not scan again. A retry never counts a person twice.
- Other ways in: type or paste the code, upload a photo of the QR, or use **Add without scanning**.

## Good to know

- This counts people. It does not check who is holding the code, because every guest has the same code. Anyone who gets the picture can use it.
- **Make a new code** (Setup) makes every picture already sent stop working. Only use it before you send invitations.
- Data lives in Netlify Blobs on your site. Entries from the earlier per-guest version are not used.
- The camera works only on the https address Netlify gives you.
- API tests: `node --test test/api.test.mjs` (uses an in-memory store).
