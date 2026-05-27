# Cross-Machine Seamlessness — Plain English

*Companion to [`CROSS-MACHINE-SEAMLESSNESS-SPEC.md`](./CROSS-MACHINE-SEAMLESSNESS-SPEC.md). Read this first; the technical spec is the appendix.*

## The dream (measured the right way: from the user's side)

Picture one employee — call her Luna — who has a desk in two offices. You should be able to walk into either office and it's the same Luna: she remembers the conversation you were just having, the task she was halfway through, everything. You never notice she's actually in two places. That's the goal: **one agent that follows you across machines with no amnesia.**

**The crucial point: "seamless" is judged entirely from the user's chair, in the actual channel — Telegram.** It's not about clever syncing under the hood; it's about what the person texting the agent experiences. The test is simple: someone is mid-conversation on Telegram, the agent quietly switches machines underneath them, and they notice *nothing* —

- no message of theirs gets lost,
- they never get the same answer twice,
- the reply still knows exactly what they were just talking about (no "sorry, who is this?"),
- no sudden "hi, how can I help you?" restart,
- no weird long pause.

Everything in this spec exists to deliver that experience. The plumbing is just the means.

### The user stories driving it

- **Failover mid-chat:** the machine serving me dies, I keep texting, I notice nothing.
- **My two machines:** same agent, same conversation, on either machine — I switch and don't miss a beat.
- **Reliability I feel but don't see:** the agent is just always there and coherent; that it spans machines is invisible. More machines = more reliable, never more noise.

## What we already had — and what we just proved

We'd already built most of the hard plumbing: the two offices know they're the same company, they share a filing cabinet, and there's a rule for who's "on duty."

On May 26 we ran it on two real machines for the very first time (your laptop and a Mac mini, using a throwaway test agent so nothing real was at risk). Two things genuinely worked:

- **Linking the two machines into one agent** — done, on real hardware.
- **A backup taking over when the main one is dark** — the mini, finding nobody home, correctly said "then I'm on duty."

## The two things that broke (this is the useful part)

1. **Two captains.** After the mini took charge, the shared directory listed *both* machines as "on duty" at once — nobody marked the powered-off laptop as "off duty." The info to fix it was sitting right there (the laptop hadn't checked in for nearly an hour), but no rule was actually enforcing the cleanup.

2. **No automatic filing.** Even with the mini running, it wasn't automatically filing its updates into the shared cabinet. I had to walk the paperwork over by hand. So the "they quietly keep each other in sync" promise wasn't actually happening.

And the headline feature — handing the conversation from one live machine to another with no memory loss — we couldn't even test yet, because that piece doesn't exist.

## What this spec builds (three pieces, in order)

1. **One captain, always.** A simple, automatic rule: if two machines both think they're on duty, the one that's actually been active recently wins, and the silent one is marked off duty. No human needed; it just settles itself. (And if it genuinely can't tell — say both are equally active — it asks you rather than flip-flopping.)

2. **Automatic filing.** The on-duty machine quietly saves its updates to the shared cabinet on a schedule, and the backup reads them. This is the thing that was missing — and we'll add a test that would have caught it.

3. **The seamless Telegram experience (the real magic).** This is the user-facing piece, and it has three parts working together: (a) the current conversation and half-finished work get continuously copied to the backup machine, so it's already caught up; (b) the Telegram "phone line" is handed over cleanly — only one machine is ever answering at a time (so you never get a double reply), and it's handed off at an exact spot so no message slips through the cracks; (c) the new machine picks up the thread instead of starting fresh, so the very next reply still knows what you were talking about. The handoff rule is strict: the new machine has to confirm "I've got everything and I've got the line" *before* the old one lets go.

## You're in control of the dial

You told me this has to be tunable — balance smoothness against wasted effort. So everything has a knob: how often they sync, how fresh the backup's copy has to be, how aggressive the handoff is. The defaults are tuned for a personal two-machine setup; someone with ten machines or a tight budget can dial it down. More machines means more reliability — without meaning more constant chatter.

## What's NOT in this spec (on purpose)

How an agent *installs itself* onto a new machine in the first place (the SSH-and-git access we set up by hand today) is a separate, related write-up — your "agent does it all after one yes" standard. I'm keeping the two specs separate so each stays focused, but they're cousins, and today's hands-on run feeds both.

## Bottom line

The foundation is real and works. The "seamless" part is now three clearly-defined pieces instead of a vague wish — and we know they're the right three because we watched the system miss exactly those on real hardware.
