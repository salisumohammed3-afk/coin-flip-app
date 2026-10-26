# LangSync Sign

LangSync's own e-signature platform, built to replace DocuSign. You run it on your own server, documents are stored on your own disk, and there's no per-envelope fee.

## What it does

| DocuSign feature | LangSync Sign |
| --- | --- |
| Envelopes with several documents | **Envelopes (packages)**: upload any number of PDFs, PNGs or JPGs. They're combined into one package. |
| Signers, approvers, "receives a copy" | Each recipient's role is **Needs to sign**, **Needs to approve**, or **Receives a copy (CC)**. |
| Signing order | Optional **routing order**: recipients act one after another, and recipients with the same number act in parallel. |
| Tagging fields | Drag-and-drop **Signature, Initials, Date signed, Full name, Email, Company, Title, Text, Checkbox** fields, colour-coded per recipient. You can move, resize, duplicate and mark fields required or optional, and nudge them with the arrow keys. |
| Comments / markup | **Pen, highlighter, box, line/strike, text and numbered comments**, for the sender before sending and (optionally) for recipients while signing. Markup is flattened into the final PDF, and comments are listed on the certificate. |
| Adopt signature | Recipients can **type** a signature (4 handwriting styles), **draw** it (mouse, trackpad or finger), or **upload** a photo. Initials are generated automatically. |
| ERSD consent | Recipients must accept the electronic records & signature disclosure before signing. Acceptance is time-stamped in the audit trail. |
| Access code authentication | Optional per-recipient **access code**. Five wrong attempts lock it for 15 minutes. |
| Status tracking | A live dashboard and per-envelope timeline (sent → viewed → signed). **Toast notifications** appear when someone views, signs or declines, and the sender gets emails at each step. |
| Reminders & expiration | One-click **Remind**, optional **automatic reminders** every N days, and **expiry** after N days. |
| Correct / Void / Decline | **Correct** fixes a wrong email (the old link stops working). **Void** stops the envelope and tells recipients why. Recipients can **decline** and give a reason. |
| Certificate of completion | The final PDF has an appended **certificate**: recipients, signature images, IP addresses, devices, consent times, SHA-256 hashes of the original documents, and the full event history. |
| Document storage | **File storage**: all completed agreements and originals, searchable and downloadable. |
| Templates | Save any envelope as a **template** (documents + recipient roles + fields + markup) and reuse it. |
| Tamper check | A public **/verify** page. Anyone can drop in a completed PDF and confirm it's authentic and unmodified (matched by SHA-256). |
| Email | Branded emails over any SMTP server (Google Workspace, SES, Postmark, Resend…). Without SMTP, every email is kept in the **Email outbox** with its link, so you can copy and share links yourself. |

## Quick start

Requires **Node.js 22.5+** (it uses Node's built-in SQLite, so nothing native has to compile).

```bash
cd langsync-sign
npm install
npm start            # http://localhost:3000
```

Open the app, create your account, and click **New envelope**.

Run the tests (full API lifecycle: send → access code → sign → approve → completed PDF → verify):

```bash
npm test
```

## Configuration

Set these as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Public URL, used in email links. **Set this in production** (e.g. `https://sign.langsync.ai`). An `https://` URL also enables secure cookies. |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the database and all files are stored. **Back this folder up.** |
| `SIGNUP_DOMAINS` | *(anyone)* | Comma-separated email domains allowed to create sender accounts, e.g. `langsync.ai` |
| `ALLOW_SIGNUP` | `true` | Set `false` once your team has accounts |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | — | Outgoing mail. If not set, emails only go to the outbox. |
| `MAIL_FROM` | `LangSync Sign <sign@langsync.local>` | From address |
| `MAX_UPLOAD_MB` | `25` | Per-file upload limit |
| `TRUST_PROXY` | `loopback` | Express trust-proxy setting, so audit trails record the real client IP behind your reverse proxy |
| `APP_NAME` | `LangSync Sign` | Name shown in emails and on certificates |

Example with Google Workspace SMTP:

```bash
BASE_URL=https://sign.langsync.ai SIGNUP_DOMAINS=langsync.ai \
SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_SECURE=true \
SMTP_USER=sign@langsync.ai SMTP_PASS='app-password' \
MAIL_FROM='LangSync Sign <sign@langsync.ai>' npm start
```

## Deploying

The app is a single process with a data folder, so any small VM works: Fly.io, Railway or Render (with a persistent volume), or a $5 VPS.

```bash
docker build -t langsync-sign .
docker run -d -p 3000:3000 -v langsync-sign-data:/app/data \
  -e BASE_URL=https://sign.langsync.ai -e SIGNUP_DOMAINS=langsync.ai langsync-sign
```

Put it behind HTTPS (Caddy, nginx, or your platform's TLS). Signing links are secrets: they're sent with `Referrer-Policy: no-referrer`, and correcting a recipient rotates their link.

Serverless platforms without a persistent disk (e.g. plain Vercel functions) won't work as-is, because the app keeps its SQLite database and files on local disk.

## How it works

```
server.js            Express API + static files
lib/workflow.js      routing order, notifications, completion, reminders/expiry sweep
lib/pdf.js           upload normalisation, stamping fields + markup, certificate of completion
lib/db.js            SQLite schema (node:sqlite)
public/js/           vanilla-JS front end (no build step)
  pages/edit.js      step 1: documents, recipients, message, settings
  pages/prepare.js   step 2: drag-and-drop fields + markup
  pages/review.js    step 3: review & send
  pages/detail.js    live tracking, history, correct/void/remind
  sign.js            recipient signing experience
  viewer.js          PDF.js rendering with overlay layer
  markup.js          annotation tools
  signature.js       adopt-signature dialog
```

Field and markup positions are stored as fractions of the displayed page, so they line up at any zoom level and on rotated pages.

## Legal note

LangSync Sign produces **simple electronic signatures** with consent capture, intent to sign, signer attribution (email link, optional access code, IP and device), and a tamper-evident record. That's the same model DocuSign's standard eSignature uses, and it's generally enforceable under the US ESIGN Act / UETA and as a simple electronic signature under eIDAS. Some document types (e.g. wills, some real-estate or regulated filings) or jurisdictions require more, such as qualified signatures, ID verification or notarisation. Check with counsel for those.

## Not included yet

- Word or Google Docs upload (export to PDF first)
- SMS or ID-verification signer authentication
- Bulk send, team sharing of envelopes between senders, public API and webhooks
