import { parse } from 'acorn';
import { ALLOWLIST, scanBundle } from './compat-gate.mjs';

const EXPECTED_RAW = new Map([
  ['finally', 6],
  ['trimStart', 1],
  ['getOrInsert', 6],
  ['getOrInsertComputed', 21],
  ['BigInt', 2],
]);

const EXPECTED_WORKER_RAW = new Map([
  ['getOrInsertComputed', 2],
]);

// Shaka installs its Map upsert polyfills on the page only, so the transmuxer
// worker gets its own copy.
const WORKER_POLYFILL = 'if(!Map.prototype.getOrInsertComputed){'
  + 'Map.prototype.getOrInsertComputed=function(k,f){'
  + 'if(!this.has(k))this.set(k,f(k));return this.get(k);};}\n';

function describe(violations) {
  return violations.map(({ name, count }) => `${name} x${count}`).join(', ') || 'none';
}

function expectViolations(label, violations, expected) {
  if (
    violations.length !== expected.size
    || violations.some(({ name, count }) => expected.get(name) !== count)
  ) {
    throw new Error(
      `Shaka compatibility assumptions changed in ${label}: `
      + `expected ${describe(Array.from(expected, ([name, count]) => ({ name, count })))}, `
      + `found ${describe(violations)}. Review the pinned Shaka bundle before updating this gate.`,
    );
  }
}

function children(node) {
  const result = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === 'string') result.push(item);
      }
    } else if (value && typeof value.type === 'string') {
      result.push(value);
    }
  }
  return result;
}

function hasBigIntAvailabilityCheck(node) {
  if (
    node.type === 'BinaryExpression'
    && node.operator === 'in'
    && node.left.type === 'Literal'
    && node.left.value === 'BigInt'
    && node.right.type === 'Identifier'
    && node.right.name === 'window'
  ) return true;
  return children(node).some(hasBigIntAvailabilityCheck);
}

function contains(outer, inner) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function validateBigIntGuards(ast) {
  const calls = [];
  const visit = (node, ancestors) => {
    if (
      node.type === 'CallExpression'
      && node.callee.type === 'Identifier'
      && node.callee.name === 'BigInt'
    ) {
      calls.push({ node, ancestors });
    }
    for (const child of children(node)) visit(child, [...ancestors, node]);
  };
  visit(ast, []);

  if (calls.length !== 2) {
    throw new Error(`Expected exactly two Shaka BigInt calls, found ${calls.length}.`);
  }
  for (const call of calls) {
    const guarded = call.ancestors.some((ancestor) =>
      ancestor.type === 'LogicalExpression'
      && ancestor.operator === '&&'
      && contains(ancestor.right, call.node)
      && hasBigIntAvailabilityCheck(ancestor.left));
    if (!guarded) {
      throw new Error('A Shaka BigInt call is not controlled by a window availability check.');
    }
  }
}

export const SHAKA_COMPAT_ALLOWLIST = [
  ...ALLOWLIST,
  {
    name: 'finally',
    reason: 'polyfilled',
    note: 'Shaka installs its guarded Promise.prototype.finally polyfill before Player use.',
  },
  {
    name: 'trimStart',
    reason: 'polyfilled',
    note: 'Shaka installs trimLeft and aliases its guarded String.prototype.trimStart polyfill.',
  },
  {
    name: 'getOrInsert',
    reason: 'polyfilled',
    note: 'Shaka installs its guarded Map.prototype.getOrInsert polyfill before Player use.',
  },
  {
    name: 'getOrInsertComputed',
    reason: 'polyfilled',
    note: 'Shaka installs its guarded Map.prototype.getOrInsertComputed polyfill on the page; '
      + 'prepareShakaWorker() adds it to the transmuxer worker.',
  },
  {
    name: 'BigInt',
    reason: 'guarded',
    note: 'The DASH timeline calls are behind a window.BigInt availability check.',
  },
];

export function validateShakaBundle(code) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 5, sourceType: 'script' });
  } catch (error) {
    throw new Error(`The Shaka bundle is not valid ES5: ${error.message}`);
  }
  if (code.indexOf('application/msf') !== -1) {
    throw new Error('The Shaka bundle unexpectedly includes the BigInt-dependent MSF parser.');
  }

  expectViolations('vendor bundle', scanBundle(code), EXPECTED_RAW);
  for (const path of [
    'Promise.prototype.finally',
    'String.prototype.trimStart',
    'Map.prototype.getOrInsert',
    'Map.prototype.getOrInsertComputed',
  ]) {
    if (code.indexOf(path) === -1) {
      throw new Error(`The Shaka bundle no longer contains its ${path} polyfill.`);
    }
  }
  validateBigIntGuards(ast);
  const violations = scanBundle(code, { allowlist: SHAKA_COMPAT_ALLOWLIST });
  if (violations.length) {
    throw new Error(`Unreviewed Shaka compatibility violations: ${describe(violations)}.`);
  }
}

export function prepareShakaWorker(code) {
  try {
    parse(code, { ecmaVersion: 5, sourceType: 'script' });
  } catch (error) {
    throw new Error(`The Shaka transmuxer worker is not valid ES5: ${error.message}`);
  }
  expectViolations('transmuxer worker', scanBundle(code), EXPECTED_WORKER_RAW);
  return WORKER_POLYFILL + code;
}
