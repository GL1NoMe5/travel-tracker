import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noticeName = /license|licence|copying|copyright|notice/i;
const textExtension = /\.(txt|md|markdown|rst|html)$/i;

// These npm tarballs omit LICENSE. Keep exact upstream text locally so builds
// stay offline; a package-version change requires reviewing the fallback.
const upstreamFallbacks = {
  '@napi-rs/wasm-runtime@1.2.2': {
    file: 'docs/third-party/napi-rs-LICENSE.txt',
    source: 'https://github.com/napi-rs/napi-rs/blob/ab2a003cb1ecf5af6b4c8b9c37aae0d8a8e7c325/LICENSE',
  },
  '@tybys/wasm-util@0.10.3': {
    file: 'docs/third-party/wasm-util-LICENSE.txt',
    source: 'https://github.com/toyobayashi/wasm-util/blob/a16b188d44ae43cc91edb71996ba2b43ff0996d9/LICENSE',
  },
};

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
}

function noticeFiles(directory, relative = '') {
  const result = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...noticeFiles(directory, filename));
    else if (entry.isFile() && noticeName.test(entry.name)
      && (!path.extname(entry.name) || textExtension.test(entry.name))) result.push(filename);
  }
  return result.sort();
}

function readNotices(directory) {
  return noticeFiles(directory).map(filename => ({
    source: filename.replaceAll('\\', '/'),
    text: readFileSync(path.join(directory, filename), 'utf8').replace(/^\uFEFF/, '').trim(),
  })).filter(notice => notice.text.length > 0);
}

function repositoryUrl(metadata) {
  const repository = metadata.repository;
  return (typeof repository === 'string' ? repository : repository?.url) ?? '';
}

function resolveNotices(root, packageDirectory, metadata) {
  const notices = readNotices(packageDirectory);
  if (notices.length) return notices;

  if (metadata.name === 'murmurhash-js' && metadata.version === '1.0.0') {
    const readme = readFileSync(path.join(packageDirectory, 'README.md'), 'utf8');
    const license = readme.match(/^## License \(MIT\)\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim();
    if (!license?.includes('Copyright (c) 2011 Gary Court') || !license.includes('Permission is hereby granted')
      || !license.includes('THE SOFTWARE IS PROVIDED')) throw new Error('murmurhash-js README license changed; review it before distribution.');
    return [{ source: 'README.md, License (MIT)', text: license }];
  }

  // Platform packages are parts of the same project and version as the wrapper.
  const parentName = metadata.name.startsWith('@rolldown/binding-') ? 'rolldown'
    : metadata.name.startsWith('@tailwindcss/oxide-') ? '@tailwindcss/oxide' : null;
  if (parentName) {
    const parentDirectory = path.join(root, 'node_modules', parentName);
    const parent = readJson(path.join(parentDirectory, 'package.json'));
    if (parent.version !== metadata.version || repositoryUrl(parent) !== repositoryUrl(metadata)
      || parent.license !== metadata.license) throw new Error(`Cannot verify shared license for ${metadata.name}.`);
    const shared = readNotices(parentDirectory);
    if (shared.length) return shared.map(notice => ({ ...notice, source: `${parentName}@${parent.version}/${notice.source} (same upstream project)` }));
  }

  const fallback = upstreamFallbacks[`${metadata.name}@${metadata.version}`];
  if (fallback) {
    if (metadata.license !== 'MIT') throw new Error(`Unexpected license for ${metadata.name}.`);
    const bytes = readFileSync(path.join(root, fallback.file));
    return [{
      source: `${fallback.source}\nVendored file: ${fallback.file}\nSHA-256: ${createHash('sha256').update(bytes).digest('hex')}`,
      text: bytes.toString('utf8').trim(),
    }];
  }
  throw new Error(`No license/notice text found for ${metadata.name}@${metadata.version}; add a reviewed upstream fallback before distribution.`);
}

export function generateNotices(root = projectRoot) {
  const lock = readJson(path.join(root, 'package-lock.json'));
  if (!lock.packages) throw new Error('package-lock.json must contain the npm packages table.');
  const sections = [];
  const omitted = [];
  for (const [relative, locked] of Object.entries(lock.packages).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    if (!relative || locked.dev) continue;
    const directory = path.resolve(root, relative);
    if (!relative.startsWith('node_modules/') || !directory.startsWith(path.resolve(root) + path.sep)) throw new Error(`Invalid package location: ${relative}`);
    const metadataPath = path.join(directory, 'package.json');
    if (!existsSync(metadataPath)) {
      if (locked.optional) { omitted.push(relative); continue; }
      throw new Error(`Required dependency is missing: ${relative}. Run npm ci.`);
    }
    const metadata = readJson(metadataPath);
    if (!metadata.name || metadata.version !== locked.version) throw new Error(`Installed dependency differs from package-lock.json: ${relative}. Run npm ci.`);
    const notices = resolveNotices(root, directory, metadata);
    sections.push([
      '='.repeat(78), `${metadata.name}@${metadata.version}`, `Package: ${relative}`,
      `Declared license: ${metadata.license ?? locked.license ?? 'See license text'}`,
      `Repository: ${repositoryUrl(metadata) || metadata.homepage || 'Not specified by package'}`,
      ...notices.map(notice => `\n--- ${notice.source} ---\n\n${notice.text}`),
    ].join('\n'));
  }
  if (!sections.length) throw new Error('No installed production dependencies found. Run npm ci.');
  const header = [
    'Travel Tracker — third-party dependency notices',
    'Generated from installed non-dev dependencies in package-lock.json.',
    'This conservative inventory includes build tools marked as production dependencies;',
    'their executables are not necessarily redistributed with the application.',
    `Packages included: ${sections.length}. Absent optional/platform packages: ${omitted.length}.`,
    'Map/data/font attribution is provided in the accompanying license files.',
  ].join('\n');
  return { text: `${header}\n\n${sections.join('\n\n')}\n`, count: sections.length, omitted };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/generate-third-party-notices.mjs <output.txt>');
    const result = generateNotices();
    const output = path.resolve(process.argv[2]);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, result.text, 'utf8');
    console.log(`Dependency notices: ${result.count} packages; ${result.omitted.length} absent optional packages skipped.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
