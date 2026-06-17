# The Daily Wind-Up

A satirical UK news site. Public homepage and article pages, plus a simple
password-protected admin page for publishing new stories.

No external npm packages — the only thing this app talks to is Supabase
(a free database + image storage service), using plain `fetch`, which is
built into modern Node.js. Nothing to `npm install`, nothing to go wrong
on a host.

## Why Supabase, briefly

Free web hosts in 2026 generally don't keep a persistent disk on their free
tiers, which means a simple "save posts to a file" approach loses everything
on restart. Supabase's free tier gives a small database and a small amount
of image storage that *does* persist, so this app stores posts there instead
of on the host's own disk. The hosting itself (Render, Railway, etc.) stays
completely free — only the database/image storage lives somewhere else, also
for free.

## One-time setup: Supabase

1. Go to supabase.com and create a free account (email signup, no card).
2. Create a new project. Pick any name and a strong database password (you
   won't need to remember this password day-to-day — it's separate from your
   site's admin password).
3. Once the project is ready, go to **Project Settings → API**. You'll need
   two things from this page:
   - The **Project URL** (looks like `https://abcxyzproject.supabase.co`)
   - The **service_role** secret key (also labelled `sb_secret_...` in newer
     projects) — NOT the "anon" / "publishable" key. The service_role key is
     what lets your server read and write posts; keep it private, it never
     goes in the browser or in any file you share publicly.
4. Go to the **SQL Editor** (in the left sidebar) and run this once, exactly
   as written, to create the table that stores your posts:

   ```sql
   create table posts (
     id text primary key,
     slug text unique not null,
     title text not null,
     kicker text,
     dek text,
     author text,
     body text not null,
     header_image text,
     mid_image text,
     created_at timestamptz not null default now()
   );

   alter table posts enable row level security;
   ```

   That last line locks the table down so nobody can read or write it
   without your secret key — your server uses the secret key, which always
   bypasses this lock, so the site keeps working normally.

5. Go to **Storage** (left sidebar), create a new bucket named exactly
   `article-images`, and when prompted, set it to **Public** (this just
   means anyone with a direct image link can view that image — normal for a
   public news site; it does not expose your admin page or your database).

That's the entire one-time setup. You won't need to touch Supabase again
day-to-day — publishing happens entirely through your site's `/admin` page.

## Environment variables

Whichever host you deploy to, set these three environment variables:

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | A password only you know, for your `/admin` page |
| `SUPABASE_URL` | Your Project URL from step 3 above |
| `SUPABASE_SECRET_KEY` | Your service_role secret key from step 3 above |

If you don't set `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, the site will run
but won't be able to load or save any posts.

## Running it locally (optional — only if you want to preview before deploying)

```
SUPABASE_URL=https://yourproject.supabase.co SUPABASE_SECRET_KEY=yourkey node server.js
```

Then visit `http://localhost:3000`. Admin page is at `http://localhost:3000/admin`.

## Deploying it (free)

Render's free web service tier works well for this, since all the data now
lives in Supabase rather than on Render's own disk — no persistent disk
needed on Render's side at all.

1. Put this code in a GitHub repository (Render deploys from a repo):
   - Create a free account at github.com if you don't have one.
   - Tap the "+" → "New repository," give it a name, tap "Create repository."
   - On the new repo's page, tap "uploading an existing file."
   - Select all four files (`server.js`, `package.json`, `README.md`,
     `style.css`) at once — they all sit in one folder with no subfolders,
     so your phone's file picker should let you multi-select them in a
     single step. Commit.
2. Create a free account at render.com, then create a new "Web Service"
   connected to that repository.
3. Build command: leave blank.
4. Start command: `node server.js`
5. Under "Environment," add the three variables listed above.
6. Deploy. Render gives you a URL like `the-daily-wind-up.onrender.com`.

Render's free tier "spins down" after about 15 minutes without visitors, so
the first visit after a quiet spell takes up to a minute to load. This is
just a cold start — none of your posts are affected, since they live in
Supabase, not on Render.

## If you ever want to spend a little money later

If you'd rather avoid the spin-down delay, the cheapest fix is upgrading
just the Render web service to its smallest paid tier (a few pounds a
month) — no code changes needed, and you can switch back to free at any
time. The Supabase side can stay free indefinitely either way.

## Publishing a story (the day-to-day workflow)

1. Freewrite emails you the text.
2. Copy the text from that email.
3. Go to `yoursite.com/admin`, log in once (your phone will remember the
   session for about a month).
4. Paste the headline into "Headline," paste the body text into "Story text."
   Leave a blank line between paragraphs — that's how the site knows where
   one paragraph ends and the next begins.
5. Optionally attach a header image and a mid-article image from your
   phone's photo library.
6. Tap Publish. Done — one screen, no extra steps.

To remove a story later, go to the admin page and tap Delete next to it in
the "Published stories" list.

## A note on images

The upload feature accepts any image file but doesn't check where the image
came from. Posting copyrighted photos (e.g. pulled directly from Google
Images search results) on a public site can create legal risk — free stock
photo sites (Unsplash, Pexels) or your own photos are safer choices.

## Files

- `server.js` — the entire backend (routes, templates, storage). One file,
  no npm dependencies.
- `style.css` — all the visual styling.

Everything sits in one folder with no subfolders, to make uploading from a
phone simpler. Your actual posts and images live in Supabase, not in this
folder — there's nothing else to back up beyond this code itself, since the
code has no secrets baked into it (those live in environment variables on
your host).

