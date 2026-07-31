# Locking down the caller lookup

`GET /customer/lookup` hands back a complete customer record — name, phone,
email, every property address, every visit with its purpose and estimate total,
warranty status and any open leads. Right now anyone who knows a phone number or
a name can read it, with no login.

It can't just be locked, because the thing that calls it is Savannah, and her
tool definitions live in the Vapi dashboard rather than in this codebase. If the
endpoint starts demanding a password before Savannah knows to send one, she stops
recognising callers — and you'd find out during someone's call.

So it's a three-step change, and step 1 is already deployed.

---

## Step 1 — done

The endpoint now logs every call that arrives without the password, and keeps
answering. Nothing has changed for Savannah.

## Step 2 — you, in the Vapi dashboard

Add one header to the tool that looks customers up.

1. Open the Vapi dashboard and find the assistant (the ID is in Railway as
   `VAPI_ASSISTANT_ID`).
2. Find the tool that calls `/customer/lookup` — it's likely named something like
   `lookup_customer` or `customer_lookup`.
3. In that tool's HTTP settings there's a **Headers** section. Add:

   | Name | Value |
   |---|---|
   | `webhook_secret` | *(the value of `WEBHOOK_SECRET` in Railway)* |

   That's the same password roughly twenty other endpoints already use, so if you
   see it on another tool in the dashboard, copy that one.

4. Save, and make one test call.

## Step 3 — confirm, then turn it on

In the Railway logs, look for lines beginning `[webhookSecret]`.

- **You still see them after a test call** — the header didn't take. The line
  names what called in. Fix the tool and try again. Don't do the next bit yet.
- **They've stopped** — every caller is sending the password. Safe to enforce.

Then in Railway, add an environment variable:

```
LOOKUP_REQUIRES_SECRET=true
```

The service restarts and the endpoint is closed. Make one more test call to
confirm Savannah still greets a known customer by name.

**If anything goes wrong:** delete `LOOKUP_REQUIRES_SECRET`. It reopens on
restart, and you're back to where you are today. Nothing else has to be undone.

---

## Still open after this

**Document links (`/api/documents/:id/pdf`).** Anyone with the link can open the
PDF — no login. That's deliberate, because customers open contracts and Health
Records from their email. But the link never expires and doesn't identify who
opened it, so a forwarded email is permanent access to that document.

The fix is a signed link that expires, which also means every link already sent
stops working. Worth doing before the Health Record goes to customers; not worth
rushing before then.

**The other public endpoints.** `/calendar/availability` and `/calendar/book` are
open. Availability only leaks how busy you are. `book` can create a calendar
entry, which is nuisance-grade rather than dangerous — but it's the same
one-header fix if you want it closed once you've done this one.

**Session tokens in URLs.** The CRM accepts a login token in the web address
(`?token=…`) as well as in the normal place. Addresses end up in server logs and
browser history in a way headers don't. Nothing in the app relies on it as far as
I can tell, so it can probably just be removed — worth a look when you're next in
that file.
