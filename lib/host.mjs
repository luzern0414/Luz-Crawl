// Runs one LuzCrawl browser command in its own process and prints the JSON result on stdout (progress goes to stderr).
// scripts/luz-crawl.mjs starts it as: node lib/host.mjs [--profile ID] luz-crawl <command> [positionals] [--options] [-f json]
// A process per command keeps environment changes made by the silent/visible browser fallback (LUZ_HEADLESS_PROFILE,
// LUZ_VISIBLE_FALLBACK) and the --profile read from process.argv confined to that command.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './commands.mjs';

export function parseCommandLine(argv, commands = COMMANDS) {
  const rest = [...argv];
  while (rest[0] === '--profile') rest.splice(0, 2);
  if (rest[0] === 'luz-crawl') rest.shift();
  const name = rest.shift();
  const spec = commands.find((command) => command.name === name);
  if (!spec) throw new Error(`Unknown LuzCrawl command: ${name ?? '(none)'}`);
  const named = new Map(spec.args.filter((arg) => !arg.positional).map((arg) => [arg.name, arg]));
  const positional = spec.args.filter((arg) => arg.positional);
  const options = {};
  const sources = {};
  const values = [];
  const convert = (arg, raw) => {
    if (arg.type === 'int') {
      const value = Number(raw);
      if (!Number.isInteger(value)) throw new Error(`--${arg.name} must be an integer.`);
      return value;
    }
    if (arg.type === 'boolean') {
      if (raw === undefined || raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`--${arg.name} takes no value.`);
    }
    return raw;
  };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '-f' || token === '--format') {
      i++;
      continue;
    }
    if (!token.startsWith('--')) {
      values.push(token);
      continue;
    }
    const [flag, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (flag === 'profile') {
      if (inline === undefined) i++;
      continue;
    }
    const negated = !named.has(flag) && flag.startsWith('no-') && named.get(flag.slice(3))?.type === 'boolean';
    const arg = named.get(negated ? flag.slice(3) : flag);
    if (!arg) throw new Error(`Unknown option for ${name}: --${flag}`);
    let raw = inline;
    if (arg.type !== 'boolean' && raw === undefined) {
      raw = rest[++i];
      if (raw === undefined) throw new Error(`--${arg.name} requires a value.`);
    }
    options[arg.name] = negated ? false : convert(arg, raw);
    sources[arg.name] = 'cli';
  }
  positional.forEach((arg, index) => {
    if (values[index] === undefined) {
      if (arg.required) throw new Error(`Missing ${arg.name} for ${name}.`);
      return;
    }
    options[arg.name] = convert(arg, values[index]);
    sources[arg.name] = 'cli';
  });
  if (values.length > positional.length) throw new Error(`Too many arguments for ${name}.`);
  for (const arg of spec.args) {
    if (arg.required && options[arg.name] === undefined) throw new Error(`--${arg.name} is required for ${name}.`);
    if (options[arg.name] === undefined && arg.default !== undefined) {
      options[arg.name] = arg.default;
      sources[arg.name] = 'default';
    }
  }
  return { spec, options: { ...options, __optionSources: sources } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { spec, options } = parseCommandLine(process.argv.slice(2));
    const result = await spec.func(options);
    process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
