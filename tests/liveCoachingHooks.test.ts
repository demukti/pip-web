import { readFileSync } from 'node:fs'
import test from 'ava'

// Live coaching hangs off four lines in the game store and two in AppBoot.
// This fork keeps merging upstream, and `src/store/game.ts` is upstream's
// busiest file: a merge that quietly drops one of those lines still builds,
// still passes every engine test, and leaves ChatGPT reading a hand that
// stopped moving. So the hooks are checked here, by reading the source, in the
// style of tests/spectate.test.ts.
//
// What this cannot cover: that the hooks fire at the right moment in a real
// browser. That still needs a hand played with sharing on.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8')
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

const STORE = 'src/store/game.ts'
const BOOT = 'src/components/AppBoot.tsx'

/** Hold'em only: every other variant publishes no hand at all. */
const HOLDEM = String.raw`hand\.variant === 'holdem' \? hand : null`

/** The body of `function name(` up to the next top-level helper. */
function body(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  return from < 0 ? '' : source.slice(from, to < 0 ? undefined : to)
}

test('the store imports the publisher', (t) => {
  t.regex(
    code(STORE),
    /import \{ livePublisher \} from '@\/lib\/liveCoaching\/publisher'/,
    'game.ts no longer imports livePublisher',
  )
})

test('a finished hand is published before the store settles it', (t) => {
  const progress = body(code(STORE), 'function progress()', 'function finishHand()')
  t.regex(
    progress,
    new RegExp(
      String.raw`if \(isHandComplete\(hand\)\) \{\s*livePublisher\.capture\(\s*${HOLDEM},\s*get\(\)\.handIndex,?\s*\)\s*finishHand\(\)`,
    ),
    'the hand-complete capture is gone',
  )
})

test("the hero's turn is published with the equity the odds panel just received", (t) => {
  const progress = body(code(STORE), 'function progress()', 'function finishHand()')
  t.regex(
    progress,
    new RegExp(
      String.raw`set\(\{ aiThinkingId: null, heroEquity: computeHeroEquity\(hand\) \}\)\s*` +
        String.raw`livePublisher\.capture\(\s*${HOLDEM},\s*get\(\)\.handIndex,\s*get\(\)\.heroEquity,?\s*\)`,
    ),
    'the hero-turn capture is gone, or no longer carries the computed equity',
  )
})

test("an AI's turn is published, without an equity", (t) => {
  const progress = body(code(STORE), 'function progress()', 'function finishHand()')
  t.regex(
    progress,
    new RegExp(
      String.raw`set\(\{ aiThinkingId: toAct\.id, heroEquity: null \}\)\s*` +
        String.raw`livePublisher\.capture\(\s*${HOLDEM},\s*get\(\)\.handIndex,?\s*\)`,
    ),
    'the AI-turn capture is gone',
  )
})

test('leaving the table publishes that there is no hand', (t) => {
  // The implementation, not the `leave: () => void` in the state interface.
  const source = code(STORE)
  const leave = source.slice(source.indexOf('leave: () => {'))
  t.regex(
    leave.slice(0, 200),
    /^leave: \(\) => \{\s*livePublisher\.capture\(null, 0\)/,
    'leave() no longer clears the shared hand first',
  )
})

test("only Hold'em is ever handed to the publisher", (t) => {
  const calls = code(STORE).match(/livePublisher\.capture\([^)]*\)/g) ?? []
  t.is(calls.length, 4, 'expected exactly the four capture sites')
  for (const call of calls)
    t.true(
      call === 'livePublisher.capture(null, 0)' ||
        new RegExp(`^livePublisher\\.capture\\(\\s*${HOLDEM}`).test(call),
      `a capture passes a hand without the Hold'em guard: ${call}`,
    )
})

test('AppBoot starts the publisher and its table context, and stops both', (t) => {
  const boot = code(BOOT)
  t.regex(boot, /import \{ livePublisher \} from '@\/lib\/liveCoaching\/publisher'/)
  t.regex(boot, /const stopSharing = livePublisher\.start\(\)/)
  // Started with the publisher, so the first snapshot after a reload already
  // carries its table. (AppBoot reaches the game store through the sync store
  // anyway, so loading this on demand would save nothing.)
  t.regex(boot, /import \{ startTableContext \} from '@\/lib\/liveCoaching\/tableContext'/)
  t.regex(
    boot,
    /const stopTableContext = startTableContext\(\)/,
    'the table context is no longer started at boot',
  )
  t.regex(boot, /stopSharing\(\)\s*stopTableContext\(\)/)
})

test('the table context derives reads the way the player dialog does', (t) => {
  const dialog = code('src/components/table/PlayerDialog.tsx')
  const context = code('src/lib/liveCoaching/tableContext.ts')
  // If the dialog changes where its reads come from, this must change with it.
  t.regex(dialog, /const reads = deriveReads\(career \?\? stats\)/)
  t.regex(context, /deriveReads\(career \?\? seatStats\[seat\.id\]\)/)
  t.regex(
    code('src/components/table/Table.tsx'),
    /stats=\{viewId \? seatStats\[viewId\] : undefined\}/,
  )
  // And never the hidden AI profile or tonight's form.
  t.notRegex(context, /seat\.ai\b|seat\.form\b|\.bio\b/)
})
