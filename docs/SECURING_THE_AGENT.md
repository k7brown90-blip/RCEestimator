# Locking down Savannah's endpoints

Three web addresses on the server answer anyone who asks, with no login. All
three exist because Savannah calls them:

| Address | What it gives out |
|---|---|
| `/customer/lookup` | A complete customer record — name, phone, email, every property address, every past job with its purpose and price, warranty status, open leads |
| `/calendar/availability` | Your free and busy times |
| `/calendar/book` | Writes a real appointment to your calendar, takes the slot, and sends a confirmation text and email to whatever phone number and address the request supplies |

The last one is the serious one. Unprotected, it's a way for someone to send
texts and emails **from your Twilio number and your Gmail account** to anyone
they like, with Red Cedar's name on them. That costs you money per message, and
enough of it gets your number reported as spam — which would stop your real
customer confirmations going out. Someone could also simply fill your calendar
so no genuine customer can book.

These can't just be switched off, because Savannah's settings live in the Vapi
dashboard rather than in the code. If the server starts demanding a password
before Savannah knows to send one, she stops working — and you'd find out during
someone's call.

So it's three steps, and step 1 is already done.

---

## Step 1 — done, nothing changed for you

All three now write a line to the log whenever they're called without the
password, and keep working exactly as before.

Booking is also limited to 5 requests a minute. Savannah books one appointment
per call, so this changes nothing for her — it just takes most of the value out
of abusing it while the rest of this is pending.

## Step 2 — you, in the Vapi dashboard

You're adding the same header to three tools.

1. Open the Vapi dashboard and find the assistant. Its ID is in Railway under
   `VAPI_ASSISTANT_ID` if you need to match it up.
2. Find the three tools. Names will be something like `lookup_customer`,
   `check_availability` and `book_appointment` — match them by the web address
   each one calls, using the table at the top.
3. Each tool has an HTTP settings area with a **Headers** section. Add the same
   thing to all three:

   | Name | Value |
   |---|---|
   | `webhook_secret` | *(the value of `WEBHOOK_SECRET` in Railway)* |

   Around twenty other endpoints already use this password, so if you find a tool
   in the dashboard that already has this header, copy that value.

4. Save all three, then make one test call that looks a customer up **and** books
   something, so all three get exercised.

## Step 3 — check the log, then turn it on

In Railway, open the logs and look for lines starting `[webhookSecret]`.

- **Still appearing after your test call** — a header didn't take. The line names
  which address is still being called without it, so you know which tool to go
  back to. Don't do the next bit yet.
- **Nothing there** — all three are sending the password. Safe to enforce.

Then add one environment variable in Railway:

```
AGENT_ENDPOINTS_REQUIRE_SECRET=true
```

The service restarts and all three close at once. Make a final test call to
confirm Savannah still greets a known customer by name and can still book.

**If anything goes wrong:** delete `AGENT_ENDPOINTS_REQUIRE_SECRET`. Everything
reopens on restart and you're back where you are today. Nothing else to undo.

---

## Deliberately left open

**Document links** (`/api/documents/:id/pdf`). Anyone with the link can open the
PDF, with no login — on purpose, because customers open contracts and Health
Records straight from their email.

The addresses contain a long random ID, so they can't be guessed or worked
through one by one. It's the same approach Google Docs uses for "anyone with the
link". The tradeoff you've accepted is that a link, once out, works forever:
there's no way to cancel one, and no record of who opened it. Worth revisiting if
Health Records start going to people you don't know well; not worth doing now.

**Login tokens in web addresses.** The CRM will accept a login token written into
the address bar (`?token=…`) as well as sent the normal way. Addresses end up in
server logs and browser history in a way that headers don't. Nothing appears to
rely on it, so it can probably just be deleted — worth a look next time anyone is
in `src/middleware/pinAuth.ts`.
