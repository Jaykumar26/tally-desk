# Tally Desk

A simple, large-type browser interface that sits on top of TallyPrime. Tally keeps running
in the background and stays the book of record; this just gives an easier window onto it.

Thirteen screens, laid out the way TallyPrime lays them out:

| Screen | Key | What it does | Touches Tally |
|---|---|---|---|
| **Money Due** | | Outstanding bills by party, with ageing and overdue flags | reads only |
| **Parties** | | Search any customer or supplier — balance, contact, open bills, statement | reads only |
| **Stock** | | Search items — closing quantity, rate and value | reads only |
| **Day End** | | The day's takings, cash position and anything still unsaved | reads only |
| **Day Bills** | | Running bills you add to through the day, saved at closing time | held locally, then **writes** on save |
| **Sales** | <kbd>F8</kbd> | A sales bill with items and GST | **writes**, after a preview you confirm |
| **Purchase** | <kbd>F9</kbd> | A supplier's bill — stock in, supplier credited | **writes**, after a preview you confirm |
| **Receipt** | <kbd>F6</kbd> | Money received, knocked off against specific bills | **writes**, after a preview you confirm |
| **Payment** | <kbd>Alt</kbd>+<kbd>F5</kbd> | Money paid out, knocked off against supplier bills | **writes**, after a preview you confirm |
| **Contra** | <kbd>F4</kbd> | Money moved between your own cash and bank accounts | **writes**, after a preview you confirm |
| **Journal** | <kbd>F7</kbd> | A free-form adjustment entry that must balance | **writes**, after a preview you confirm |
| **Credit Note** | <kbd>Ctrl</kbd>+<kbd>F8</kbd> | Goods a customer sent back | **writes**, after a preview you confirm |
| **Debit Note** | <kbd>Ctrl</kbd>+<kbd>F9</kbd> | Goods sent back to a supplier | **writes**, after a preview you confirm |

## How it looks

The interface is laid out the way TallyPrime is, so the shape is familiar before a
single word is read:

- a **blue title bar** carrying the product, the open company and the current date
- a **breadcrumb strip** naming the screen you are standing on
- the **workspace on the left**, with report titles centred and ruled as Tally titles a report
- the **function-key button panel down the right**, grouped into Reports, Counter, Vouchers
  and Setup, with the screen you are on marked in Tally's selection yellow
- a **status line pinned at the foot**, showing the Tally connection and which gateway it is
  reading, with the text-size buttons at the far end

The header, breadcrumb and status line stay put; only the workspace scrolls. Numbers are
tabular throughout, so columns of figures line up as they do in Tally's own reports.

The entry screens use **the same function keys as Tally**, so the habit carries over.
<kbd>F1</kbd> is left alone because the browser owns help, and Payment moves to
<kbd>Alt</kbd>+<kbd>F5</kbd> because <kbd>F5</kbd> alone reloads the page.

## Returns

A **credit note** is a customer sending goods back: they are credited and the stock comes
back on the shelf. A **debit note** is the mirror — goods returned to a supplier, who is
debited as the stock goes out.

Both offer the party's open bills so the note settles **against the original invoice**
(`Agst Ref`) rather than raising a loose new reference. Leaving the bill blank is allowed
and raises a new one instead.

## Printing

Two things print, both as clean documents with none of the screen's buttons and panels on
them.

**A bill, to give the customer.** There is a **Print** button on every bill:

| Where | Which bill |
|---|---|
| **Money Due** → a party's card → each bill row | Any bill already saved in Tally |
| **Parties** → a party → open bills | The same, from their own page |
| **Day End** → every entry of the day | Anything entered that day |
| **Sales / Purchase / Credit Note / Debit Note** | The one being typed, before it is saved |
| **Day Bills** → a running bill | The day's tab so far |

A saved bill is **read back out of Tally** and reprinted with its own items, taxes and total,
so a customer can be given a copy months later. It prints as an itemised bill when the
voucher carries stock lines, and as a list of particulars when it does not — which is what
Tally prints for the same voucher.

Printing also works before anything is saved, so a customer can be handed their bill while
the entry is still being checked. Anything printed that has not reached Tally is stamped
*"Not yet recorded in Tally"* on the paper itself.

**A bill-wise outstanding statement** — the reminder you hand a customer for collection.
Every unsettled bill with its date, due date, days overdue and balance. Available three ways:

| From | Prints |
|---|---|
| **Money Due** → *Print bill-wise* | Everyone, grouped by party with subtotals, a grand total and an ageing summary |
| **Money Due** → a party's card → *Print bill-wise* | That one party, as a plain numbered list |
| **Parties** → a party → *Print bill-wise* | The same, with their phone, GSTIN and address on it |

Searching first narrows what prints, so typing a name and pressing print gives you that one
statement. The ageing summary is left off a filtered print, because those figures describe
the whole report rather than the few lines in front of you. The payable side prints the same
way, worded as what you owe. If there is nothing outstanding it says so instead of printing
a blank sheet.

## Day End

The closing report for a chosen day:

- what was sold, received, purchased and paid out, and how many vouchers were entered
- a breakdown by voucher type, and every individual entry
- where the cash and bank balances stand
- **a warning naming any day bill still not saved to Tally** — closing up without noticing
  that is the mistake this screen exists to prevent

It reads the day's vouchers back **out of Tally** rather than totalling what this program
happened to send, so entries your father makes directly in Tally are counted too. The whole
summary prints.

## Day Bills

For the customer who buys three things in the morning and comes back for four more at
night. Instead of two vouchers, the evening's items are **appended to the morning's bill**,
and the whole thing goes to Tally once at closing time.

- Opening a bill for a customer who already has one open today reuses it, so the second
  visit cannot accidentally start a separate voucher.
- Each line records the time it was added, so the evening's items are distinguishable from
  the morning's on screen.
- A bill left open overnight is **never** dropped. It keeps showing, tagged with its date,
  until it is saved or deliberately discarded.
- **Save all to Tally** posts every open bill at closing time. Each becomes its own voucher
  and is saved independently — if one is refused the rest still go through, and you are told
  exactly which failed and why.

Until you press save these live only in `data/day-bills.json` on that computer, never in
Tally. The screen says so at the top and labels the total "not yet in Tally", because a bill
that looks saved but isn't is the one genuinely dangerous thing this feature could do. The
file is written atomically, so an interrupted write cannot corrupt a day's takings, and a
failed save leaves the bill exactly where it was.

Each entry screen enforces what Tally enforces, but says so in plain words before anything is
sent: a contra must move between two *different* cash or bank accounts, a journal must have
debits equal to credits and at least one of each, and any line naming a bill-wise party must
say which bill it belongs to. The journal screen shows a running Dr/Cr total and a
balanced / out-by badge as you type.

No installer, no database, no npm packages. It is plain Node.js talking to Tally's own
XML gateway.

---

## Try it right now (no Tally needed)

```bash
node scripts/demo.js
```

Then open <http://localhost:4001>. This runs against invented data from a fake gateway —
useful for showing someone the screens before touching real books. Nothing real is read or
written.

---

## Setting it up on the Tally computer

### 1. Install Node.js

Download the **LTS** version from <https://nodejs.org> and install it with all the defaults.
This is a one-time step.

### 2. Copy this folder onto the computer

Anywhere is fine — `C:\TallyDesk` is easy to remember. Nothing else needs installing; there
are no dependencies to download, so the computer does not need internet after this.

### 3. Switch on Tally's connection

In **TallyPrime**:

1. Press <kbd>F1</kbd> → **Settings** → **Connectivity**
2. Set **"TallyPrime acts as"** to **Both** (or *Server*)
3. Leave **Port** at **9000**
4. Press <kbd>Ctrl</kbd>+<kbd>A</kbd> to accept

(On the older Tally.ERP 9 the same setting lives under <kbd>F12</kbd> → *Advanced
Configuration* → *Tally.ERP 9 is acting as: Both*.)

Tally must be **open with the company loaded** whenever Tally Desk is used.

### 4. Start it

Double-click **`start.bat`**. A black window opens and the browser goes to
<http://localhost:4000>. **Keep the black window open** — closing it stops the program.

To make this easy for daily use: right-click `start.bat` → *Send to* → *Desktop (create
shortcut)*, then rename the shortcut to something obvious. To start it automatically with
Windows, press <kbd>Win</kbd>+<kbd>R</kbd>, type `shell:startup`, and drop a copy of the
shortcut into the folder that opens.

---

## What has been verified against a real TallyPrime

Tested against a live TallyPrime gateway, not just the stand-in:

- every read — companies, ledgers, bills, stock, voucher types, godowns, licence state
- master creation — ledgers, units, stock groups, stock items, and GST alterations
- **receipt posting, including knocking a payment off a specific bill** (an ₹8,000 receipt
  correctly reduced bill INV-1001 from ₹18,101.20 to ₹10,101.20)
- accounting-only sales invoices with bill references and GST ledgers
- **contra posting** (₹5,000 bank to cash: HDFC Bank ₹8,500 → ₹3,500 Dr, Cash ₹0 → ₹5,000 Dr)
- **journal posting, including an "Agst Ref" bill allocation** (a ₹475 discount reduced
  Nova Hardware's bill INV-1005 from ₹3,975 to ₹3,500 and Sales from ₹1,61,515 to ₹1,61,040)
- **payment posting** (₹2,500 cash to a supplier: Cash ₹5,000 → ₹2,500, supplier to ₹2,500 Dr)
- **day bills** — appending a second visit to the morning's bill, and the refusal path
  leaving the bill safely untouched
- **the day-end summary**, totalled from real vouchers and correctly flagging an unsaved
  day bill
- **bill-wise outstanding statements**, against live balances — the full report grouped by
  party (4 parties, ₹1,70,633.20) and a single party's statement
- **reprinting a saved bill** — INV-1002 read back out of Tally and printed for the customer
  with its own particulars and ₹73,868.00 total

Sales, Purchase, Credit Note and Debit Note *carry stock items*, and are the one group still
unproven against a real gateway, because the Tally available for testing is unlicensed and
refuses stock vouchers outright. The full save cycle for those is verified against the stand-in gateway, and every
other voucher type is verified against real Tally.

Three things that only a real gateway revealed, now covered by tests:

| | |
|---|---|
| Balances are **credit-positive** | A debtor's balance arrives as a *negative* number. The code flips it so positive means "they owe us". Getting this backwards inverts every figure on screen. |
| A "Bills" collection returns `<BILL>` | Singular, not `<BILLS>`. Reading the plural finds nothing and Money Due silently shows zero. |
| Counters live in `<IMPORTRESULT>` | TallyPrime, not the `<RESPONSE>` that Tally.ERP 9 used. Reading the wrong one makes a successful save look like a failure. |

### If Tally is unlicensed

An unlicensed Tally runs in **Educational mode**, which the app detects and warns about on
screen. It refuses far more than it explains:

- vouchers are accepted **only on the 1st, 2nd or last day of a month** — any other date is
  rejected as the misleading "Voucher date is missing"
- **bills carrying stock items are refused outright**, reported only as an unexplained
  exception count

Reading is unaffected. On a licensed Tally none of these limits apply, and the New Bill
screen works normally with stock items.

## Before trusting it with real invoices

The reading screens are safe — they cannot change anything. The two writing screens should
be proven on a **test company** first, because every Tally company is configured a little
differently:

1. In Tally, create a throwaway company (or use a copy of the real one).
2. Point Tally Desk at it: **Settings** tab → pick that company → *Save*.
3. Make one bill and one receipt from Tally Desk.
4. Open the voucher in Tally (*Gateway → Day Book*) and check the ledgers, amounts, tax and
   bill reference are all where they should be.
5. Only then switch the Settings tab back to the real company.

Things that vary by company and are worth checking on that first test:

- **GST.** The bill screen splits GST evenly into **CGST and SGST**, which is correct for a
  sale inside your own state. Interstate sales need IGST — those must be made in Tally, or
  the tax added afterwards. If the company has no ledgers named CGST/SGST the bill is posted
  without tax and a warning is shown rather than guessing.
- **Bill-wise details.** The Money Due screen needs *Maintain bill-wise details* switched on
  for party ledgers. Without it Tally has no bill references to report.
- **Voucher numbering.** If your sales voucher type numbers automatically, leave the
  reference field for your own bill number; Tally assigns the voucher number itself.
- **Educational mode.** An unlicensed Tally refuses most vouchers. The error is passed
  through as-is.

---

## Safety

- The program listens on **127.0.0.1 only** — nothing outside that computer can reach it.
  Tally's gateway has no password, and neither does this, so it deliberately stays local.
  Do not port-forward it.
- **Nothing is written without a confirmation.** Both writing screens show the exact ledger
  entries, Dr/Cr sides and total before anything is sent, and the server refuses any post
  request that does not carry an explicit confirmation.
- Everything saved from here is appended to **`data/posted-vouchers.jsonl`** and listed under
  *Settings → Recently saved from here*, so a mistake can always be traced and then cancelled
  inside Tally.
- Vouchers are only ever **created**. Nothing in this program alters or deletes existing
  Tally data.

---

## When something looks wrong

| What you see | What it means |
|---|---|
| "Tally is not answering on 127.0.0.1:9000" | Tally is closed, or the Connectivity setting in step 3 is off. |
| "Tally did not reply within 60 seconds" | Tally is usually showing a dialog box on screen. Close it. |
| "No company is open in Tally" | Load the company in Tally first. |
| Money Due is empty but Tally shows outstandings | Bill-wise details are probably off for those party ledgers. Switch on *Maintain bill-wise details* in the ledger. |
| "Educational mode" warning at the top | Tally is unlicensed. Reading is fine; see the section above for what saving cannot do. |
| A bill will not save, with no clear reason | Tally reports refusals as a bare exception count. Check the licence, and that the date falls inside the company's current period. |
| A screen is empty or a column is blank | Use **Settings → Diagnostics**, run the matching request, and press *Copy result*. That gives the exact XML Tally sent, which is enough to pin down any difference in your Tally version. |
| "Port 4000 is already in use" | It is probably already running. Otherwise change `appPort` in `config.json`. |

---

## Configuration

`config.json`, or the Settings screen for the common ones:

```json
{
  "host": "127.0.0.1",   // the computer Tally runs on
  "port": 9000,          // Tally's gateway port
  "company": "",         // blank = whichever company is open in Tally
  "appPort": 4000,       // the port this interface serves on
  "timeoutMs": 60000,    // how long to wait for Tally
  "cacheMs": 20000       // how long master lists are reused before re-reading
}
```

## Changing the wording

Every phrase shown on screen sits in the `LABELS` object at the top of
[`public/app.js`](public/app.js), and the tab names are in
[`public/index.html`](public/index.html). Translating the interface means editing those two
places — no logic is involved. The **A−** and **A+** buttons in the corner change text size
and the choice is remembered.

## Layout

```
server.js              local web server and the JSON API
lib/tally.js           talks to Tally's gateway; turns failures into plain sentences
lib/requests.js        builds the XML sent to Tally
lib/api.js             turns Tally's XML into clean data for the screens
lib/vouchers.js        validates, previews, posts and logs new vouchers
lib/daybills.js        running bills held locally until they are saved to Tally
lib/xml.js             small XML reader tuned to Tally's output
lib/format.js          Tally's date, quantity and amount formats
lib/mock-tally.js      a stand-in gateway, for testing without Tally
public/                the interface itself
test/                  run with: npm test
scripts/demo.js        run the whole thing against invented data
scripts/seed-test-company.js   fill an EMPTY Tally company with sample data
scripts/add-gst-to-masters.js  add GST details to those sample masters
```

The two `scripts/seed-*` and `scripts/add-gst-*` files are development aids for setting up a
throwaway test company. `seed-test-company.js` refuses to run against a company holding any
ledger it did not create, so it cannot be pointed at real books by accident. Neither is
needed for normal use and both can be deleted before handing the folder over.

## Tests

```bash
npm test
```

Runs against the stand-in gateway, so no Tally is needed. It covers the XML parsing, the
Tally date/quantity/amount formats, the Dr/Cr sign convention on generated vouchers, and the
validation rules that stop a bad invoice or receipt before it is sent.
