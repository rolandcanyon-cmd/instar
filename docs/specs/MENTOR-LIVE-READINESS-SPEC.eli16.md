# Making the mentor actually testable with Codey — in plain terms

## What this fixes

Today the mentor system is built but can't truly run against Codey, for three reasons we
caught during the dry-run yesterday:

1. The "is Codey free to be mentored right now?" check isn't actually about Codey — it
   just looks at whether *I* have anything going on, which I always do. So it'd back off
   forever and never run.
2. The "budget" cap is a dollar amount, but we're on a Claude subscription, not a per-token
   bill. The setting was never read by any code anyway, and nothing would ping you if it
   tripped.
3. When the mentor decides to send Codey a note, my side writes the note to a file — but
   nothing on Codey's side reads that file. So a "live test" today would write into the
   void.

## How we fix all three

**1. A real "is Codey free?" check.** Codey adds a small public status page on his side
that simply says: am I busy or free right now, plus when I last started up. I check that
page before each mentor cycle. If anything's off — page unreachable, weird response, just-
restarted, anything ambiguous — I treat him as busy and wait. Better to skip a cycle than
to mentor at a bad moment.

**2. The budget gets recast in the right units.** Instead of pretend dollars, I use your
real quota meter (the one tracking your 5-hour and weekly limits) and a token-spend
ceiling — and I ping you the *first* time we hit the cap, and again when we recover. If we
trip and recover and re-trip the same day, you hear about all three. The state is written
to disk so a server restart doesn't re-spam you with old alerts.

**3. The note actually reaches Codey.** I keep writing my notes to a file (that part was
the *deliberate* safe choice — no spawning, no loops). Codey adds a small background job
on his side that wakes up every minute, reads any new notes from that file, and feeds them
to him as if you'd typed them. Then he writes his reply back to a second file my side
reads.

Codey himself designed his side (he picked the simpler, more crash-survivable approach and
specified the message format with built-in safety checks). The whole loop has eight rules
that make it structurally impossible for us to bounce messages back and forth — and we
hardened those rules so they're enforced by the code shape itself, not just by good
intentions.

## What we learned from yesterday — baked in

You called out two things I should have caught: the busy-check was bogus, and the budget
was a dead setting. My new rule (now durable in my memory): before I tell you a gate, limit,
or delivery "works," I read the actual code and tell you which file:line I checked. The
revised spec applies this everywhere — every claim cites the code, and a third gap I caught
*myself* this morning (the file Codey never reads) only surfaced because I applied that rule
before claiming "live test, ready to go."

## What's next

This spec went through two rounds of multi-reviewer convergence (three reviewers each
round). The reviewers caught the original "/sessions has no idle field and needs auth"
blocker that would've broken the live test, plus the symlink/restart/concurrency edge cases
worth defending against ahead of time. All addressed.

Codey has agreed to his side of the design (verified on Threadline). I'm sending him the
final spec to confirm the two small new requests on his side that came out of convergence
(the small /idle endpoint and pinning a shared contract version). Once you approve, I'll
build my side through our normal gate, Codey builds his, both ship, then we run **one
supervised live cycle against him with you watching** — the actual test.
