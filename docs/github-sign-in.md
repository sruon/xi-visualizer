# Signing in to GitHub

Contributors edit a zone in the browser and propose the result as a pull request. They do not need
push access to the data repository and they do not need to create a token: they sign in, and if they
cannot push, the change goes to their own fork and the pull request comes back to yours.

## Why a relay is needed

`api.github.com` sends CORS headers, so everything after sign-in happens directly from the page.
`github.com/login/*` does not, so the token exchange cannot be done by a browser at all. That is
true of every flow, PKCE included, so a static site needs something in the middle.

The device flow is the one worth using here, because it **needs no client secret**. The relay is
therefore not a secret-holder: it forwards two POSTs and adds a header, and there is nothing in it
worth stealing. `workers/github-relay.js` is the whole thing, 50 lines.

## Setting it up, once

1. **Create an OAuth app**: github.com/settings/developers → New OAuth App. Any callback URL will
   do, the device flow does not use it. Tick **Enable Device Flow**, or GitHub answers every request
   with `device_flow_disabled`. Copy the client id; it is public and belongs in the build.

2. **Deploy the relay** and allow the site's origin in its `ALLOWED` list:

   ```
   npx wrangler deploy workers/github-relay.js --name github-relay --compatibility-date 2026-01-01
   ```

3. **Point the build at both**, in `.github/workflows/gh-pages.yml` under the existing `env:`:

   ```yaml
   VITE_GH_CLIENT_ID: Iv1.xxxxxxxxxxxx
   VITE_GH_RELAY: https://github-relay.<your-subdomain>.workers.dev
   ```

   Locally, put the same two names in `.env.local`. With neither set, the sign-in button does not
   appear and the editor asks for a pasted token exactly as it does today.

## What contributors get asked for

The scope requested is `public_repo`: enough to write to public repositories, and no reach at all
into private ones. That matters because the token is kept in the browser's localStorage. If the data
repository is ever made private this has to become `repo`, which grants a great deal more, and is a
good reason to keep the data public.

## What happens on Propose

- With push access: a `regions/<zone>` branch on the data repository, and a pull request from it.
- Without: the repository is forked (idempotent, an existing fork is reused), the branch is made
  there, and the pull request is opened across to the data repository. The status line says
  `PR opened via <your-login>` so it is clear where the commits went.

Both paths reuse an open pull request for the same zone rather than opening a second one.
