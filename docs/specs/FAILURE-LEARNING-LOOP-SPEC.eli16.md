# Failure-Learning Loop — the plain-English version

## The one-sentence idea

When something we built breaks later, automatically write down *what broke*, trace it back to *exactly what produced it* — the spec, the project, and the tools we used to build and review it — and slowly learn from the pile of those records so we keep making the same mistake less often.

## Why this matters

Right now, building software here works like a kitchen with no incident book. A dish goes out, a few weeks later a customer sends it back, the cook fixes it, and… that's it. The lesson lives in one cook's head and disappears. Next week a different cook makes a similar mistake, because nobody wrote down that the recipe step was unclear, or that nobody tasted it before it left.

This builds the incident book — but a smart one. Every time something we shipped breaks, it doesn't just record "this broke." It records "this broke, it came from *this* recipe (spec), it was made on *this* station (project), and it was cooked with *this* set of tools and checked by *these* inspectors." Once you have a stack of those, you stop asking "what went wrong this one time?" and start asking the much more useful question: "what about *how we work* keeps letting this kind of thing slip through?" Maybe one recipe template is always vague. Maybe one inspector never catches a certain kind of mistake. Maybe one cooking tool skips a step. You can only see that pattern if you wrote down the cause every time.

## The hard part, said honestly

The tricky bit is connecting "the thing that broke today" back to "the thing we built three weeks ago." Sometimes that trail is clean and we can follow it automatically — if a fix undoes a specific change, we can walk that change back to the feature it belonged to. But plenty of breakages show up sideways, and for those we'll need a quick one-tap "this traces back to feature X" at the moment someone figures it out — not a long form to fill in. We're being upfront: it's automatic where the trail is clean, one tap where it isn't, and a guess is always *labeled* as a guess instead of pretended to be certain.

## The clever reuse

We don't build a whole new system from scratch. Two things we already have do most of the work. The initiative board already remembers which spec and which code-change each feature came from — so a failure just attaches to the right card. And every time we change Instar's own code, the rules already force us to leave a little receipt of what we did. We just make that receipt also note *which build tool and which review steps* were used. That one small addition is what makes it possible to later say "features built with tool A break more than features built with tool B" — which is exactly what we need, because we're about to have different build tools for different kinds of work.

## What you'll actually notice

Mostly nothing day to day — it works quietly in the background, like the rollout board does. But when enough has piled up, you'll get an occasional, calm heads-up: "we've now seen this kind of bug five times, and they all share this one thing about how we built them — here's a concrete way to tighten the process." It never blocks anyone, never grades anyone, and never changes the process on its own. It just makes the blind spots visible so you can decide what to fix. Over time, the whole point is simple: we build with fewer failures because we finally remember the ones we had.

## How careful we're being

It's mandatory but invisible — the recording happens where the work already happens, so nobody has to remember to do it. It only speaks up when there's genuinely enough evidence to mean something (two unlucky coincidences never get dressed up as a "pattern"). And it ships dark first and matures on the rollout board we just built — fittingly, this feature is its own first test case.
