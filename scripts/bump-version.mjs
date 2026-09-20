// Bump the version in package.json, so every build is identifiable.
//
//   npm run bump            -> patch  (2.0.0 -> 2.0.1)  small fixes
//   npm run bump minor      -> minor  (2.0.1 -> 2.1.0)  new features
//   npm run bump major      -> major  (2.1.0 -> 3.0.0)  breaking / big releases
//
// electron-builder puts the version in the artifact names, so bumping is what
// stops "Lyrigen Setup 2.0.0.exe" from silently meaning six different builds.

import { readFileSync, writeFileSync } from 'node:fs'

const kind = (process.argv[2] || 'patch').toLowerCase()
if (!['major', 'minor', 'patch'].includes(kind)) {
  console.error(`Unknown bump "${kind}". Use major, minor or patch.`)
  process.exit(1)
}

const file = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const [major, minor, patch] = String(pkg.version).split('.').map(Number)
if ([major, minor, patch].some(part => !Number.isFinite(part))) {
  console.error(`package.json version "${pkg.version}" is not major.minor.patch.`)
  process.exit(1)
}

const next = kind === 'major' ? [major + 1, 0, 0] : kind === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1]
const version = next.join('.')
pkg.version = version
// Keep the trailing newline npm itself writes.
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`${kind}: ${major}.${minor}.${patch} -> ${version}`)
