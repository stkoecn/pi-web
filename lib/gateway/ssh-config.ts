import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveDeviceConfig, JumpHost } from "./types/device";

/**
 * The hosts `~/.ssh/config` already knows about.
 *
 * The gateway used to ask the user to retype what ssh had been told years ago:
 * address, port, user, key path. Those are exactly the fields `ssh <alias>`
 * reads, so the file is the list. Discovery does not replace `devices.json`:
 * an entry there still wins for the same id, which is how a password-only host
 * (impossible to express in ssh config) and a reverse tunnel stay possible.
 */

/** One host as the file describes it, before it becomes a device. */
export interface SshConfigHost {
  /** The alias the user types after `ssh`. Becomes the device id. */
  alias: string;
  /** `HostName`, or the alias when the block names none. */
  hostName: string;
  port: number;
  username: string;
  /** Absolute path to the key, when the block named one that exists. */
  privateKeyPath?: string;
  /** Hops to dial through before the target, resolved from `ProxyJump`. */
  jump?: JumpHost[];
  /** Set when the block uses a keyword the gateway cannot honour. */
  unsupported?: string;
}

/**
 * One stanza the pane cannot offer, with the reason already phrased.
 *
 * A plain string list was only ever read by a developer: it went to the log and
 * the pane showed "N hosts cannot be used, see the log". The alias and the
 * reason are what a reader needs, so they are kept apart from the file/line
 * prefix that is still useful in the log.
 */
export interface SshConfigProblem {
  /** `path:line` as it reads in the log. */
  where: string;
  /** The `Host` alias the line is about, when the line is about one. */
  alias?: string;
  /** The reason, without the prefix. */
  reason: string;
}

export interface SshConfigRead {
  path: string;
  hosts: SshConfigHost[];
  /** Lines the parser skipped, so a silent miss is explainable. */
  problems: SshConfigProblem[];
  /** Set when the file itself could not be read. Missing file is not an error. */
  error?: string;
}

/** A block's keywords, in file order, with the first occurrence winning per keyword. */
interface Block {
  patterns: string[];
  /** `Host` line number, for problem messages. */
  line: number;
  options: Map<string, string>;
}

const KEYWORDS = new Set([
  "host",
  "hostname",
  "port",
  "user",
  "identityfile",
  "proxyjump",
  "proxycommand",
  "include",
]);

function stripComment(line: string): string {
  // `#` starts a comment only at the beginning of a token: an IdentityFile may
  // legitimately contain one, and ssh treats it the same way.
  const match = /(^|\s)#/.exec(line);
  return match ? line.slice(0, match.index) : line;
}

/**
 * Split a line into keyword and argument.
 *
 * ssh accepts both `Keyword value` and `Keyword=value`, and the value keeps its
 * spaces (a path may contain them), so this does not split on whitespace twice.
 */
function splitLine(line: string): { keyword: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const eq = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(trimmed);
  if (eq) return { keyword: eq[1].toLowerCase(), value: eq[2].trim() };
  const space = /^(\S+)\s+(.*)$/.exec(trimmed);
  if (space) return { keyword: space[1].toLowerCase(), value: space[2].trim() };
  return { keyword: trimmed.toLowerCase(), value: "" };
}

/** `*` and `?` make a block a set of defaults, not a host someone can pick. */
function isPattern(alias: string): boolean {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!");
}

function expandTokens(value: string, alias: string, hostName: string, username: string, home: string): string {
  return value
    .replace(/%d/g, home)
    .replace(/%h/g, hostName)
    .replace(/%n/g, alias)
    .replace(/%r/g, username)
    .replace(/^~(?=$|\/)/, home);
}

function parseBlocks(text: string, sourcePath: string, problems: SshConfigProblem[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = stripComment(lines[index]);
    const parsed = splitLine(raw);
    if (!parsed) continue;
    if (!KEYWORDS.has(parsed.keyword)) {
      // Unknown keywords are normal (ForwardAgent, ServerAliveInterval, …).
      // They are collected anyway so a block can be reported as unsupported
      // when one of them changes how a connection must be opened.
      if (current) current.options.set(parsed.keyword, parsed.value);
      continue;
    }
    if (parsed.keyword === "host") {
      const patterns = parsed.value.split(/\s+/).filter(Boolean);
      current = { patterns, line: index + 1, options: new Map() };
      blocks.push(current);
      continue;
    }
    if (!current) {
      // A keyword before the first Host block applies to every host; the
      // gateway has no use for a global default that is not a host.
      problems.push({ where: `${sourcePath}:${index + 1}`, reason: `${parsed.keyword} outside a Host block` });
      continue;
    }
    // First obtained value wins, exactly as ssh resolves it.
    if (!current.options.has(parsed.keyword)) current.options.set(parsed.keyword, parsed.value);
  }
  return blocks;
}

/** `Include` files are read in place, so a shared `config.d/*.conf` works. */
function readIncludes(
  patterns: string[],
  sourcePath: string,
  home: string,
  problems: SshConfigProblem[],
): string[] {
  const texts: string[] = [];
  for (const pattern of patterns) {
    const expanded = expandTokens(pattern, "", "", "", home);
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(path.dirname(sourcePath), expanded);
    let matches: string[] = [];
    try {
      matches = fs.globSync(absolute).sort();
    } catch (error) {
      problems.push({ where: sourcePath, reason: `cannot expand Include ${pattern}: ${message(error)}` });
      continue;
    }
    for (const match of matches) {
      try {
        texts.push(fs.readFileSync(match, "utf8"));
      } catch (error) {
        problems.push({ where: match, reason: `cannot read Include: ${message(error)}` });
      }
    }
  }
  return texts;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a `ProxyJump` value into the hops the gateway will dial.
 *
 * The value is a comma-separated list of either bare aliases (`wscomp`) or
 * `user@host:port` triples. An alias is resolved against the config, so a hop
 * keeps its own key and port. Anything unresolvable yields an empty list, and
 * the caller reports the host as unsupported rather than dialling straight at
 * a target that is unreachable by design. `undefined` means "could not resolve";
 * an empty list is `ProxyJump none`, which is a decision to dial directly.
 */
function resolveJumpChain(
  value: string,
  byAlias: Map<string, JumpHost>,
  defaults: Map<string, string>,
  home: string,
  osUser: string,
  exists: (filePath: string) => boolean,
  sourcePath: string,
  line: number,
  problems: SshConfigProblem[],
): JumpHost[] | undefined {
  const hops: JumpHost[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const known = byAlias.get(entry);
    if (known) {
      hops.push(known);
      continue;
    }
    // `user@host:port` — the form ssh allows without a config block.
    // Numbered groups, not named ones: the project targets a pre-ES2018 lib.
    const match = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(entry);
    const host = match?.[2];
    if (!match || !host) {
      problems.push({
        where: `${sourcePath}:${line}`,
        reason: `ProxyJump ${entry} is neither a host alias nor user@host:port`,
      });
      return undefined;
    }
    const port = match[3] === undefined ? 22 : Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push({ where: `${sourcePath}:${line}`, reason: `ProxyJump ${entry} has a port that is not a port` });
      return undefined;
    }
    const hop: JumpHost = {
      alias: entry,
      host,
      port,
      username: match[1] ?? defaults.get("user") ?? osUser,
    };
    const keyPath = defaults.get("identityfile");
    if (keyPath) {
      const resolvedKey = expandTokens(keyPath, entry, host, hop.username, home);
      if (exists(resolvedKey)) hop.privateKeyPath = resolvedKey;
    }
    hops.push(hop);
  }
  return hops;
}

/**
 * Every host a user could `ssh` to, in the order the file defines them.
 *
 * Wildcard blocks still contribute their keywords to the concrete blocks that
 * follow them (that is how `Host *` sets a default User), so they are applied
 * as a fallback instead of being dropped.
 */
export function parseSshConfig(text: string, options: {
  sourcePath?: string;
  home?: string;
  osUser?: string;
  exists?: (filePath: string) => boolean;
} = {}): { hosts: SshConfigHost[]; problems: SshConfigProblem[] } {
  const sourcePath = options.sourcePath ?? path.join(options.home ?? os.homedir(), ".ssh", "config");
  const home = options.home ?? os.homedir();
  const osUser = options.osUser ?? os.userInfo().username;
  const exists = options.exists ?? ((filePath: string) => fs.existsSync(filePath));
  const problems: SshConfigProblem[] = [];

  const blocks = parseBlocks(text, sourcePath, problems);

  // Include files are parsed as if their lines sat where the directive is, so
  // a config that keeps its real hosts in `config.d/` lists them.
  const includeBlocks: Block[] = [];
  for (const block of blocks) {
    const include = block.options.get("include");
    if (!include) continue;
    for (const included of readIncludes(include.split(/\s+/), sourcePath, home, problems)) {
      includeBlocks.push(...parseBlocks(included, `${sourcePath} (Include)`, problems));
    }
  }
  const ordered = [...includeBlocks, ...blocks];

  const defaults = new Map<string, string>();
  for (const block of ordered) {
    if (!block.patterns.every(isPattern)) continue;
    for (const [keyword, value] of block.options) {
      if (!defaults.has(keyword)) defaults.set(keyword, value);
    }
  }

  /**
   * Every alias' own connection fields, resolved before any host is emitted.
   *
   * `ProxyJump wscomp` names an alias whose block may sit anywhere in the file,
   * so the hops are looked up here rather than as the loop reaches them.
   */
  const byAlias = new Map<string, JumpHost>();
  for (const block of ordered) {
    for (const alias of block.patterns) {
      if (isPattern(alias) || byAlias.has(alias)) continue;
      const lookup = (keyword: string) => block.options.get(keyword) ?? defaults.get(keyword);
      const hostName = expandTokens(lookup("hostname") ?? alias, alias, alias, lookup("user") ?? osUser, home);
      const username = lookup("user") ?? osUser;
      const portText = lookup("port");
      const port = portText === undefined ? 22 : Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const hop: JumpHost = { alias, host: hostName, port, username };
      const keyPath = lookup("identityfile");
      if (keyPath) {
        const resolvedKey = expandTokens(keyPath, alias, hostName, username, home);
        if (exists(resolvedKey)) hop.privateKeyPath = resolvedKey;
      }
      byAlias.set(alias, hop);
    }
  }

  const hosts: SshConfigHost[] = [];
  const seen = new Set<string>();
  for (const block of ordered) {
    /**
     * A block that names its address lists aliases of one machine.
     *
     * `Host ib-us2-et 10.8.8.22` with `HostName 10.8.8.22` is two ways to say
     * the same host — same user, same port, same key — so the pane showed one
     * machine twice. The first alias is the name the reader chose for it.
     * Without `HostName` each pattern *is* an address, so those stay separate.
     */
    const aliasesOfOneHost = block.options.get("hostname") !== undefined || defaults.get("hostname") !== undefined
      ? block.patterns.slice(0, 1)
      : block.patterns;
    for (const alias of aliasesOfOneHost) {
      if (isPattern(alias) || seen.has(alias)) continue;
      seen.add(alias);
      const lookup = (keyword: string) => block.options.get(keyword) ?? defaults.get(keyword);
      const hostName = expandTokens(lookup("hostname") ?? alias, alias, alias, lookup("user") ?? osUser, home);
      const username = lookup("user") ?? osUser;
      const portText = lookup("port");
      const port = portText === undefined ? 22 : Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push({
          where: `${sourcePath}:${block.line}`,
          alias,
          reason: `has port ${String(portText)}, which is not a port`,
        });
        continue;
      }
      const host: SshConfigHost = { alias, hostName, port, username };
      const keyPath = lookup("identityfile");
      if (keyPath) {
        const resolved = expandTokens(keyPath, alias, hostName, username, home);
        if (exists(resolved)) host.privateKeyPath = resolved;
        else {
          problems.push({
            where: `${sourcePath}:${block.line}`,
            alias,
            reason: `names a key that does not exist: ${resolved}`,
          });
        }
      }
      // `ProxyJump` is a chain of logins the gateway opens itself (see
      // `lib/gateway/ssh-jump.ts`), so the hops have to be resolved here: each
      // one is an alias that may carry its own user, port and key.
      const jump = lookup("proxyjump");
      if (jump) {
        if (jump.trim().toLowerCase() === "none") {
          // `ProxyJump none` cancels a default set by a `Host *` block.
        } else {
          const resolved = resolveJumpChain(jump, byAlias, defaults, home, osUser, exists, sourcePath, block.line, problems);
          if (resolved === undefined) host.unsupported = `ProxyJump ${jump}`;
          else if (resolved.length > 0) host.jump = resolved;
        }
      } else if (lookup("proxycommand")) {
        // A shell command is not something the gateway can run without handing
        // it a shell; that stays unsupported and says so.
        host.unsupported = "ProxyCommand";
      }
      // `User git` is how every hosting service is written, and there is no
      // shell on the other end: a device row for github.com can only ever
      // fail. Skipping it is a rule about the *account*, not the address, so a
      // real machine that happens to use a `git` login is the one case it gets
      // wrong — and `devices.json` still describes that one by hand.
      if (username === "git" && !jump) {
        problems.push({
          where: `${sourcePath}:${block.line}`,
          alias,
          reason: `logs in as "git", so it is a code host, not a machine`,
        });
        continue;
      }
      hosts.push(host);
    }
  }
  return { hosts, problems };
}

/** Read the file a user's `ssh` would read. A missing file is not an error. */
export function readSshConfig(options: { configPath?: string; home?: string } = {}): SshConfigRead {
  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(home, ".ssh", "config");
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: configPath, hosts: [], problems: [] };
    }
    return { path: configPath, hosts: [], problems: [], error: `cannot read ${configPath}: ${message(error)}` };
  }
  const parsed = parseSshConfig(text, { sourcePath: configPath, home });
  return { path: configPath, hosts: parsed.hosts, problems: parsed.problems };
}

/**
 * A device id from an ssh alias.
 *
 * The id reaches URLs, session folder names and the reverse tunnel's SSH
 * username, all of which want a slug. Aliases like `192.168.0.25.windsing` or
 * `ib-us1-et` already are one; a dotted quad is kept as-is because it is what
 * the user recognises.
 */
export function deviceIdFromAlias(alias: string): string {
  const slug = alias
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "host";
}

/** A discovered host as a device config the pool can dial. */
export function sshHostToDevice(host: SshConfigHost): ActiveDeviceConfig {
  const config: ActiveDeviceConfig = {
    id: deviceIdFromAlias(host.alias),
    name: host.alias,
    host: host.hostName,
    port: host.port,
    username: host.username,
    mode: "active_ssh",
  };
  if (host.privateKeyPath) config.privateKeyPath = host.privateKeyPath;
  if (host.jump && host.jump.length > 0) config.jump = host.jump;
  return config;
}
