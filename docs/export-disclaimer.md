# Important Note — Tally Data Export

**Please read before running a full data export.**

## What this tool does

The connector reads your Tally data and exports it — including **every available
field of every record** — into CSV files (and on to your chosen destination). This
gives you a complete, comprehensive extract of your Tally information.

## The technical reality (please note)

Tally's built-in HTTP/XML gateway is **single-threaded** and was designed for
**targeted, on-demand lookups** — not for exporting *all* fields of *all* records in
one go. Pulling a complete dataset ("fetch everything") pushes Tally well beyond the
kind of request it normally handles.

Because of this, on larger companies **Tally may temporarily become slow, stop
responding, or appear "stuck" (wedged) while an export is running.** This is a
characteristic of how Tally itself is built, not a fault in your data.

## What we have done about it

We have engineered the connector specifically to minimise this risk:

- Data is fetched in **small, bounded batches** instead of one giant request, so Tally
  is never asked to build the entire dataset at once.
- Requests are **sent one at a time** (never overlapping), which is what Tally's gateway
  can safely handle.
- **Automatic retries and adaptive splitting** kick in if a batch is too heavy.
- Every run is **logged in detail** so any issue can be quickly identified and resolved.

As a result, this is **dramatically safer** than a naive "export all" — but because the
underlying limitation is in Tally, we **cannot guarantee** it will never happen on every
possible company size and configuration.

## How the connector interacts with Tally

The connector only **reads** from Tally — it does not write to, edit, or delete anything
in your company. In normal operation, if Tally becomes unresponsive during an export you
can **restart Tally Prime and reopen the company** to return to normal, and then re-run.

## Please back up your data first

Because a full export drives Tally harder than everyday use, **please take a current
backup of your Tally company data before running an export**, and ensure your own
regular backup routine is in place.

## Disclaimer of liability

You use this tool and run exports **at your own risk**. While we have taken significant
measures to make the process as safe as possible, the underlying limitation lies within
Tally's own export gateway and is **outside our control**. Accordingly, **we do not
accept any responsibility or liability for any data loss, data corruption, downtime, or
business disruption** arising from the use of this connector or from Tally becoming
unresponsive during an export. It is your responsibility to maintain adequate backups.

## Recommendations for a smooth export

- **Take a backup** of your Tally company data before running a large export.
- Run large exports when **Tally is not being actively used** for other work.
- Keep the **company open** in Tally with its HTTP server enabled (port 9000).
- Prefer running big, first-time exports **during off-peak hours**.
- If Tally does get stuck, don't force-close mid-way unnecessarily — give it a moment;
  if it stays unresponsive, restart Tally and try again.

---

*If you run into any issue, share the connector's log file (`sync-log.txt`) with us — it
records exactly what happened and where, so we can help resolve it quickly.*
