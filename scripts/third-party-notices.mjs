import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const PACKAGES = [
  ['assjs', 'MIT', 'LICENSE'],
  ['fflate', 'MIT', 'LICENSE'],
  ['iso-639-1', 'MIT', 'LICENSE'],
  ['iso-639-2', 'MIT', 'license'],
  ['qrcode-generator', 'MIT', null],
  ['shaka-player', 'Apache-2.0', 'LICENSE'],
  ['mpegts.js', 'Apache-2.0', 'LICENSE'],
  ['esbuild', 'MIT', 'LICENSE.md'],
  ['typescript', 'Apache-2.0', 'LICENSE.txt'],
];

const VENDORED_FILES = [
  ['licenses/SOURCES.txt', 'licenses/SOURCES.txt'],
  ['licenses/ass-compiler.txt', 'licenses/ass-compiler.txt'],
  ['licenses/qrcode-generator.txt', 'licenses/qrcode-generator.txt'],
  ['licenses/twemoji.txt', 'licenses/twemoji.txt'],
  ['licenses/shaka-cml-cmcd.txt', 'node_modules/shaka-player/third_party/cml-cmcd/LICENSE'],
  ['licenses/shaka-cml-cmcd-NOTICE.txt', 'node_modules/shaka-player/third_party/cml-cmcd/NOTICE'],
];

function readRequired(rootDir, file) {
  const content = readFileSync(join(rootDir, file), 'utf8');
  if (!content.trim()) throw new Error(`Empty third-party license or notice: ${file}`);
  return content;
}

function validateGraph(metafiles, packages) {
  const reviewed = new Set(packages.map(([name]) => name));
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replaceAll('\\', '/');
      for (const match of normalized.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)) {
        if (!reviewed.has(match[1])) {
          throw new Error(`Package ${match[1]} needs a reviewed third-party license entry.`);
        }
      }
    }
  }
}

export function writeThirdPartyNotices({
  outDir,
  rootDir = ROOT,
  metafiles = [],
}) {
  validateGraph(metafiles, PACKAGES);

  const manifest = JSON.parse(readRequired(rootDir, 'package.json'));
  const reviewed = new Set(PACKAGES.map(([name]) => name));
  for (const name of Object.keys(manifest.dependencies)) {
    if (!reviewed.has(name)) {
      throw new Error(`Package ${name} needs a reviewed third-party license entry.`);
    }
  }

  const files = new Map([
    ['LICENSE', readRequired(rootDir, 'LICENSE')],
  ]);
  const versions = [];
  for (const [name, license, licenseFile] of PACKAGES) {
    const directory = `node_modules/${name}`;
    const installed = JSON.parse(readRequired(rootDir, `${directory}/package.json`));
    if (installed.license !== license) {
      throw new Error(`Review the changed third-party license for ${name}: ${installed.license}`);
    }
    // These upstream bundles embed code whose notices are maintained here.
    const reviewedVersion = {
      assjs: '0.1.10',
      'qrcode-generator': '2.0.4',
    }[name];
    if (reviewedVersion && installed.version !== reviewedVersion) {
      throw new Error(`Review embedded third-party notices for ${name} ${installed.version}`);
    }
    versions.push(`${name} ${installed.version}`);
    if (licenseFile) {
      files.set(`licenses/${name}.txt`, readRequired(rootDir, `${directory}/${licenseFile}`));
    }
  }
  for (const [output, source] of VENDORED_FILES) {
    files.set(output, readRequired(rootDir, source));
  }
  let notices = readRequired(rootDir, 'THIRD_PARTY_NOTICES.txt');
  notices += `\nInstalled package versions\n--------------------------\n${versions.join('\n')}\n`;
  files.set('THIRD_PARTY_NOTICES.txt', notices);

  const destination = resolve(outDir);
  if (destination === resolve(rootDir)) {
    throw new Error('Third-party notices must be written to a build output directory.');
  }
  rmSync(join(destination, 'licenses'), { recursive: true, force: true });
  for (const [file, content] of files) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
