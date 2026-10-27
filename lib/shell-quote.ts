/**
 * POSIX single-quote escaping for values interpolated into a remote shell
 * command.
 *
 * The gateway sends commands to `sh` on the device, so a path with a space, a
 * quote or a `$` must be quoted as data. Single quotes make everything literal;
 * the only character they cannot contain is a single quote, which is closed,
 * escaped and reopened (`'\''`). Writing that sequence inline in a template
 * literal is how quoting bugs start — `\'` inside a template is just `'`.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
