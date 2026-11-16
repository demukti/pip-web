import { readFileSync } from 'node:fs'
import test from 'ava'

// The coach touches upstream in three places: AppBoot starts it, the table mounts
// its button and card, and Settings mounts its section. The game store has no
// hooks at all: the hand is read from it when the player asks. This fork keeps
// merging upstream, and a merge that quietly drops one of these lines still
// builds and still passes every engine test, so they are checked here, by
// reading the source, in the style of tests/spectate.test.ts.
//
// What this cannot cover: a browser. That still needs a hand played and asked about.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8')
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

test('the game store knows nothing of the coach', (t) => {
  t.notRegex(code('src/store/game.ts'), /askCoach|liveCoaching|livePublisher/)
})

test('AppBoot starts the coach’s memory of the store, and stops it', (t) => {
  const boot = code('src/components/AppBoot.tsx')
  t.regex(boot, /import \{ startAskCoach \} from '@\/lib\/askCoach\/table'/)
  t.regex(boot, /const stopAskCoach = startAskCoach\(\)/)
  t.regex(boot, /stopAskCoach\(\)/)
})

test('the table mounts the button in the panel’s corner and, around the hero’s row, the card', (t) => {
  const table = code('src/components/table/Table.tsx')
  t.regex(table, /const coachButton = <AskCoachButton hand=\{handIndex\} \/>/)
  // The panel's bottom-left corner on a phone and on a desktop alike.
  t.regex(table, /const phoneCorners = \{[^}]*bottomLeft: coachButton,?\s*\}/)
  t.regex(table, /corners=\{\{ bottomLeft: coachButton \}\}/)
  // The corner the button sits in is upstream's, shared with a room's turn clock.
  t.regex(code('src/components/table/parts.tsx'), /\{corners\.bottomLeft\}/)
  t.regex(table, /<AskCoachCard hand=\{handIndex\} \/>/)
  // The box around the hero's row positions the card and sets no z-index, so
  // the card stacks against the whole table (over the result banner).
  t.regex(table, /\{hero && heroMeta && \(\s*<div className="relative">/)
})

test('Settings mounts the Coach section in the dialog and the screen', (t) => {
  for (const path of [
    'src/components/settings/SettingsDialog.tsx',
    'src/components/settings/SettingsScreen.tsx',
  ])
    t.regex(code(path), /<AskCoachSection \/>/, path)
})

test('the table context derives reads the way the player dialog does', (t) => {
  const dialog = code('src/components/table/PlayerDialog.tsx')
  const context = code('src/lib/askCoach/table.ts')
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
