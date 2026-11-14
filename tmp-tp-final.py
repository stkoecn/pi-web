import io

def edit(path, fn):
    s = io.open(path, encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in s else '\n'
    s2 = fn(s, eol)
    io.open(path, 'w', encoding='utf-8', newline='').write(s2)
    print(path, 'done (eol=%r)' % eol)

def join(lines, eol):
    return eol.join(lines)

def tp(s, eol):
    # 1. the caller already holds `header` (the auto-merge kept the pread):
    #    pass it through.
    old_call = "  return chunkFromBuffer(buffer, bytesRead, fileSize, offset);"
    assert old_call in s
    s = s.replace(old_call, "  return chunkFromBuffer(buffer, bytesRead, fileSize, offset, header);", 1)

    # 2. the pure function takes the file-start header.
    fn_lines = [
        "export function chunkFromBuffer(",
        "  buffer: Buffer,",
        "  bytesRead: number,",
        "  fileSize: number,",
        "  offset: number,",
        "): TextPreviewChunk {",
    ]
    old_fn = join(fn_lines, eol)
    assert old_fn in s, 'fn anchor missing'
    new_fn_lines = [
        "export function chunkFromBuffer(",
        "  buffer: Buffer,",
        "  bytesRead: number,",
        "  fileSize: number,",
        "  offset: number,",
        "  /** The file's first 2 bytes; a slice at offset > 0 does not carry them. */",
        "  fileHeader?: Buffer,",
        "): TextPreviewChunk {",
    ]
    s = s.replace(old_fn, join(new_fn_lines, eol), 1)

    # 3. the dangling `header[0]` reads resolve against the argument.
    utf_lines = [
        "  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);",
        '  const utf16 = header[0] === 0xff && header[1] === 0xfe ? "utf-16le"',
        '    : header[0] === 0xfe && header[1] === 0xff ? "utf-16be" : null;',
    ]
    old_utf = join(utf_lines, eol)
    assert old_utf in s, 'utf16 anchor missing'
    new_utf_lines = [
        "  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);",
        "  // At offset 0 the buffer starts with the BOM; later chunks carry it in",
        "  // `fileHeader` (fetched alongside the slice, local pread or device read).",
        "  const header = fileHeader ?? (offset === 0 ? buffer : undefined);",
        "  const utf16 = header && header.length >= 2",
        '    ? header[0] === 0xff && header[1] === 0xfe ? "utf-16le"',
        '      : header[0] === 0xfe && header[1] === 0xff ? "utf-16be" : null',
        "    : null;",
    ]
    s = s.replace(old_utf, join(new_utf_lines, eol), 1)
    return s

edit('lib/text-preview.ts', tp)

# remote-files.ts: the earlier script already ran its const/return edits? It
# reported done before text-preview failed — verify and finish it idempotently.
def rf(s, eol):
    if 'SLICE_HEADER_MARKER' not in s:
        old_const = 'const SLICE_SIZE_MARKER = "@@piweb-size@@";'
        assert old_const in s
        s = s.replace(old_const, old_const + eol + 'const SLICE_HEADER_MARKER = "@@piweb-header@@";', 1)
    old_ret_type = "): Promise<{ bytes: Buffer; size: number }> {"
    count = s.count(old_ret_type)
    assert count == 2, count
    s = s.replace(old_ret_type, "): Promise<{ bytes: Buffer; size: number; header?: Buffer }> {")

    if 'SLICE_HEADER_MARKER}`' not in s:
        script_lines = [
            "    `if [ -d ${quoted} ]; then printf '%s-2\\\\n' '${SLICE_SIZE_MARKER}'; exit 0; fi`,",
            "    `if stat -f '%z'",
        ]
        old_script = join(script_lines, eol)
        assert old_script in s, 'script anchor missing'
        new_lines = [
            "    `if [ -d ${quoted} ]; then printf '%s-2\\\\n' '${SLICE_SIZE_MARKER}'; exit 0; fi`,",
            "    // A slice at offset > 0 does not carry the file-start BOM, which decides",
            "    // UTF-16 decoding for every chunk: the same round trip fetches the first",
            "    // 2 bytes alongside the slice.",
            "    ...(offset > 0 ? [",
            "      `printf '%s' '${SLICE_HEADER_MARKER}'`,",
            "      `head -c 2 ${quoted} | base64`,",
            r"      `printf '\\n'`,",
            "    ] : []),",
            "    `if stat -f '%z'",
        ]
        s = s.replace(old_script, join(new_lines, eol), 1)

    if 'const header: Buffer | undefined;' not in s:
        parse_lines = [
            "  const markerAt = result.stdout.indexOf(SLICE_SIZE_MARKER);",
            "  if (markerAt < 0) {",
            "    return { bytes: Buffer.alloc(0), size: -1 };",
            "  }",
        ]
        old_parse = join(parse_lines, eol)
        assert old_parse in s
        new_parse_lines = parse_lines + [
            "  let header: Buffer | undefined;",
            "  const headerAt = result.stdout.indexOf(SLICE_HEADER_MARKER);",
            "  if (headerAt >= 0) {",
            "    const headerAfter = result.stdout.slice(headerAt + SLICE_HEADER_MARKER.length);",
            '    const headerLine = headerAfter.slice(0, headerAfter.indexOf("\\n")).trim();',
            '    header = Buffer.from(headerLine.replace(/\\s+/g, ""), "base64");',
            "  }",
        ]
        s = s.replace(old_parse, join(new_parse_lines, eol), 1)

    ret_lines = [
        "  return {",
        "    bytes,",
        "    size: Number.isFinite(size) ? size : -1,",
        "  };",
        "}",
    ]
    old_ret = join(ret_lines, eol)
    if old_ret in s:
        new_ret_lines = [
            "  return {",
            "    bytes,",
            "    size: Number.isFinite(size) ? size : -1,",
            "    header,",
            "  };",
            "}",
        ]
        s = s.replace(old_ret, join(new_ret_lines, eol), 1)
    return s

edit('lib/remote-files.ts', rf)

def fr(s, eol):
    if 'const { bytes, size, header } = await readRemoteSliceWithSize(' not in s:
        old_a = join([
            "      const { bytes, size } = await readRemoteSliceWithSize(",
            "        driver,",
            "        filePath,",
            "        offsetEarly,",
            "        TEXT_PREVIEW_MAX_BYTES + 1,",
            "      );",
        ], eol)
        assert old_a in s
        new_a = join([
            "      const { bytes, size, header } = await readRemoteSliceWithSize(",
            "        driver,",
            "        filePath,",
            "        offsetEarly,",
            "        TEXT_PREVIEW_MAX_BYTES + 1,",
            "      );",
        ], eol)
        s = s.replace(old_a, new_a, 1)
    if 'chunkFromBuffer(bytes, bytes.length, size, offsetEarly, header)' not in s:
        old_b = "const chunk = chunkFromBuffer(bytes, bytes.length, size, offsetEarly);"
        assert old_b in s
        s = s.replace(old_b, "const chunk = chunkFromBuffer(bytes, bytes.length, size, offsetEarly, header);", 1)
    if 'const { bytes: buffer, header } = await readRemoteSlice(' not in s:
        old_c = join([
            "      const buffer = await readRemoteSlice(driver, filePath, offset, length);",
            "      const chunk = chunkFromBuffer(buffer, buffer.length, stat.size, offset);",
        ], eol)
        assert old_c in s
        new_c = join([
            "      const { bytes: buffer, header } = await readRemoteSlice(driver, filePath, offset, length);",
            "      const chunk = chunkFromBuffer(buffer, buffer.length, stat.size, offset, header);",
        ], eol)
        s = s.replace(old_c, new_c, 1)
    return s

edit('app/api/files/[[...path]]/route.ts', fr)
